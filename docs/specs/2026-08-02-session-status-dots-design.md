# Pastilles d'état par session (vert / bleu) — design

Date: 2026-08-02 · Statut: validé avec le propriétaire (Germain) en brainstorming ; approche « status hub » recommandée, à confirmer à la relecture.

## Problème

Germain fait tourner plusieurs sessions Atelier en parallèle. Il veut, d'un
coup d'œil sur la liste de gauche, savoir :

- **quelle conversation est en train de travailler** (Claude stream un tour) →
  pastille **verte** ;
- **quelle conversation a fini et l'attend** (le tour vient de se terminer,
  message non encore lu) → pastille **bleue** ;
- les autres sessions restent neutres.

La pastille bleue doit se **vider quand il ouvre / focus la session** concernée.

### Contrainte structurante (vérifiée dans le code)

Le serveur **continue de faire tourner un tour même quand le socket client se
ferme** (`apps/server/src/stream/session-stream.ts:80-83` : « a bare disconnect
never aborts — the turn keeps running »). Une session de fond travaille donc
réellement côté serveur — la prémisse de la feature tient.

**Mais** le client n'ouvre **qu'un seul WebSocket à la fois**, celui de la
session focalisée : `SessionController.open()` ferme le socket précédent
(`apps/web/src/state/session-controller.ts`). Aujourd'hui la pastille verte
signifie littéralement « la session active, et elle stream »
(`App.tsx:357` : `streamingSessionId = stream.status === 'streaming' ? selected.sessionId : null`).
Les sessions de fond **ne peuvent donc rapporter aucun état**. Afficher
vert/bleu pour une session non focalisée exige un **nouveau flux d'état par
session**, indépendant du socket actif unique.

Le `dotState()` actuel (`apps/web/src/components/SessionSidebar.tsx:146-150`)
ne connaît que `'run' | 'idle' | 'done'` et dérive `'run'` uniquement de
`streamingSessionId`.

## Décisions

1. **Flux d'état dédié : « status hub » (approche recommandée).** On ajoute un
   abonnement unique, toujours ouvert, qui diffuse `{ sessionId, state }` pour
   **toutes** les sessions actives. Le serveur possède déjà le registre de tous
   les `SessionStream` clefé par id de session résolu
   (`session-stream.ts:316-358`), chacun portant son `state` en mémoire
   (`'idle' | 'streaming' | 'error'`). Le hub relaie ces transitions.
   - Rejeté — **A. garder N sockets ouverts** : imposerait de restructurer
     `SessionController` (aujourd'hui un seul `StreamState`) en map par session
     et d'ouvrir N sockets reconnectants ; touche le code client le plus
     porteur pour un gain identique. Le hub est purement additif : le streaming
     actif (deltas, permissions) reste inchangé.
   - Rejeté — **actif seulement** : ne montrerait que la session focalisée,
     abandonnant l'objectif « quelle *autre* conversation travaille / attend ».

2. **Le serveur ne rapporte que l'état live `streaming | idle | error`.** Il
   n'a pas à connaître le « bleu ». La transition qui compte est
   `streaming → idle` sur `turn_done` (`session-stream.ts:236-243`, où
   `state='idle'` puis `broadcast(snapshot())`), plus le settle du `finally`
   (`session-stream.ts:161-173`) pour les fins sans `turn_done`.

3. **Le « bleu / en attente » est dérivé côté client.** Une session passe en
   bleu quand elle transite `streaming → idle` **alors qu'elle n'est pas la
   session focalisée**, et le reste jusqu'à ce qu'on la focus. C'est un état
   relatif au focus (« a fini depuis la dernière fois que je l'ai regardée »),
   donc intrinsèquement client. Le client maintient :
   - `Map<sessionId, 'streaming' | 'idle' | 'error'>` alimentée par le hub ;
   - un `Set<sessionId>` des complétions **non acquittées** (transition vers
     `idle` observée hors focus).

4. **Vidage au focus.** `selectSession` (`App.tsx:195-203`) retire la session
   du set des non-acquittées. ⚠️ Le garde de ré-entrée `App.tsx:197`
   (`if (selected?.sessionId === session.id) return`) court-circuite un
   re-clic sur la session déjà active : si l'utilisateur est **déjà** sur la
   session quand elle finit, le bleu ne doit de toute façon jamais s'allumer
   (règle 3 : hors focus uniquement), donc ce garde ne pose pas de problème.

5. **Priorité des pastilles.** Pour une session donnée :
   `streaming` (vert) > complétion non acquittée (bleu) > logique existante
   (`idle` pour draft / 0 message, sinon `done`). Le vert prime toujours : une
   session qui redémarre un tour n'est plus « en attente ».

6. **Tout dégrade en silence.** Le hub est un confort. S'il se déconnecte ou
   n'émet rien, les pastilles retombent sur la dérivation actuelle
   (`run` pour la session active qui stream, sinon `idle`/`done`) ; aucun échec
   ne doit gêner l'envoi de messages ni afficher de bannière.

## Architecture

### Serveur — le status hub

- **Nouvelle surface** : un flux diffusant `{ type: 'session_status', sessionId, state }`
  à chaque transition d'état d'un `SessionStream`, plus un **snapshot initial**
  à la connexion (état courant de toutes les sessions au registre — même patron
  que `onConnect` qui renvoie `snapshot()`, `session-stream.ts:54-59`).
- **Source** : hooker les points où `state` change déjà et sont broadcastés —
  `runTurn` (`streaming` à `session-stream.ts:116`), `turn_done`
  (`idle`, 236-243), `turn_error` (244-252), settle `finally` (161-173),
  `materializeDraft` (mapping draft→réel, 267-272). Le hub réémet l'état résolu
  avec le `sessionId` déjà estampillé (`session-stream.ts:291-294`).
- **Remap draft→réel** : le hub doit relayer le `mapping` (ou émettre sous le
  `sessionId` résolu) pour que le client ne garde pas une entrée fantôme sous
  l'id de draft.
- **Choix de transport** (à trancher au plan) : un WebSocket dédié
  `/api/sessions/status` (cohérent avec l'existant `/api/sessions/:id/stream`,
  `ws.ts:68`) ou un SSE. Le WS est le défaut par cohérence.

### Client — abonnement, store, dérivation

- **Abonnement unique** monté au niveau `App`, indépendant de
  `SessionController`. Il alimente une petite source externe
  (`useSyncExternalStore`, comme `App.tsx:110-113`) exposant
  `statuses: Map<sessionId, state>` et `waiting: Set<sessionId>`.
- **Dérivation du bleu** : à chaque `session_status` reçu, si la transition est
  `→ idle` **et** `sessionId !== selected?.sessionId`, ajouter au set
  `waiting`. Sur `→ streaming` (ou focus), retirer du set.
- **Pastille** : étendre `SessionDotState` (`SessionListItem.tsx:9`) avec
  `'waiting'` et passer la nouvelle dérivation à `dotState()`
  (`SessionSidebar.tsx:146-150`) :
  ```
  if (statuses.get(session.id) === 'streaming') return 'run'      // vert
  if (waiting.has(session.id)) return 'waiting'                    // bleu
  if (session.isDraft || session.messageCount === 0) return 'idle'
  return 'done'
  ```
  La pastille se rend déjà en `SessionListItem.tsx:32`
  (`<span className="dot" data-state={state} …/>`) — aucun nouveau markup.
- **CSS** : ajouter `.dot[data-state='waiting']` (bleu) dans
  `apps/web/src/styles.css` près des variantes existantes (209-212). Le vert
  garde son pulse (`styles.css:427-431`, respecte `prefers-reduced-motion`) ;
  le bleu est statique.

### Flux de données (bout en bout)

1. Session B (non focalisée) reçoit un `user_message` → `runTurn` →
   `state='streaming'` → hub émet `session_status{B, streaming}` → pastille B
   **verte**.
2. Le tour finit → `turn_done` → `state='idle'` → hub émet
   `session_status{B, idle}` → B n'est pas focalisée → `waiting.add(B)` →
   pastille B **bleue**.
3. Germain clique B → `selectSession(B)` → `waiting.delete(B)` → pastille B
   retombe sur `done`/`idle` ; `SessionController.open(B)` prend le relais pour
   le streaming détaillé habituel.

## Hors périmètre (YAGNI)

- Badge Dock / menubar / notification OS quand la fenêtre n'a pas le focus
  (extension naturelle une fois le set `waiting` disponible — plan séparé si
  voulu).
- Son, compteur agrégé « N sessions en attente ».
- Persistance du set `waiting` entre redémarrages de l'app (éphémère : au
  relancement, les sessions sont relues depuis l'historique, pas « en attente »).

## Tests (intentions)

- Serveur : le hub émet un snapshot initial à la connexion ; émet
  `streaming` au démarrage de tour, `idle` sur `turn_done`, `error` sur
  `turn_error` ; relaie le remap draft→réel sous le bon id.
- Client (dérivation) : `→ idle` hors focus ⇒ bleu ; `→ idle` **sur** la
  session focalisée ⇒ pas de bleu ; `→ streaming` prime le bleu ; focus vide le
  bleu ; déconnexion du hub ⇒ repli silencieux sur la dérivation actuelle.
- Composant : `SessionListItem` rend `data-state='waiting'` ; `dotState`
  respecte la priorité vert > bleu > idle/done.
