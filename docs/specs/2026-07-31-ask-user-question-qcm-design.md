# QCM natif (AskUserQuestion) — design

Date : 2026-07-31
Statut : validé (brainstorming avec Germain)
À lire avec : `2026-07-31-default-permission-mode-design.md` (compose — voir « Interaction avec le mode par défaut »).

## Problème

Quand Claude pose un QCM via l'outil `AskUserQuestion` (1-4 questions, 2-4 options
chacune, multi-select, « Other » implicite), Atelier le traite comme n'importe quelle
demande de permission : le `PermissionPrompt` générique s'affiche avec
Refuser / Autoriser / Toujours. Impossible de **sélectionner une réponse**. Pire :

- « Autoriser » renvoie l'input inchangé — le SDK attend `updatedInput.answers`
  rempli par le composant de permission de l'hôte ; sans lui, aucune réponse ne
  parvient au modèle.
- Une règle « always » stockée qui matcherait `AskUserQuestion` l'auto-allowerait
  **silencieusement** : question avalée, jamais affichée.
- En mode skip-permissions (`permissionMode: 'bypassPermissions'` SDK), `canUseTool`
  est court-circuité : le QCM ne remonte jamais à la UI.

## Décisions (validées owner)

1. **Parité complète** avec Claude Code : multi-questions (chips `header`), options
   avec label + description (+ `preview` optionnel), multiSelect, champ libre
   « Autre » par question. Les `annotations` SDK (notes par sélection) sont **hors
   v1** (YAGNI).
2. **Le QCM marche partout**, y compris en skip-permissions : le mode bypass devient
   un auto-allow sélectif dans `canUseTool` (tout sauf `AskUserQuestion`) au lieu du
   `permissionMode: 'bypassPermissions'` du SDK.
3. **Taper un message pendant un QCM = y répondre en texte** : le QCM pendant est
   refusé proprement (« L'utilisateur a répondu directement dans le chat ») et le
   message part via la file existante au prochain idle.
4. **Broker dédié** (`QuestionBroker`), pas une extension du `PermissionBroker` :
   une permission se *décide*, une question se *répond* — sémantiques disjointes,
   et les règles « always » deviennent structurellement inapplicables au QCM.

## État actuel (ce qui existe)

- `PermissionBroker.request` est branché tel quel sur `canUseTool`
  (`session-stream.ts` L128) ; il consulte les règles stockées puis publie un
  `permission_request`. Cycle de vie éprouvé : `pending()` ré-émis à chaque
  `onConnect`, `abort()` = deny all, `resolve` one-shot fail-closed.
- `buildQueryOptions` (`sdk-client.ts` L254-258) **écrase** tout `updatedInput` du
  résultat : il ré-échoe l'input original (contrainte CLI bundlé : `updatedInput`
  Zod-requis sur allow). Il devra faire transiter celui du broker.
- Skip-permissions : `bypassPermissions: true` → `permissionMode: 'bypassPermissions'`
  + `allowDangerouslySkipPermissions: true` (L252) — `canUseTool` jamais appelé.
- File de messages mid-turn : **client-side** (`session-controller.ts`), items
  `queued: true`, envoi du plus ancien à chaque settle idle. Le serveur droppe un
  `user_message` mid-turn.
- `PermissionPrompt.tsx` : carte inline non-modale, live region `role="alert"`
  pendant pending, boutons désactivés une fois résolue — pattern a11y à copier.
- SDK 0.3.198 : `AskUserQuestionInput.questions[]` = `{question, header, options:
  {label, description, preview?}[], multiSelect}` ; réponse attendue =
  `updatedInput.answers: Record<questionText, réponse>` (multi-select joint par
  `", "` — contrat de `AskUserQuestionOutput.answers`).

## Architecture

### 1. Contrat partagé — `packages/shared/src/protocol.ts`

```ts
export type QcmOption = { label: string; description: string; preview?: string }
export type QcmQuestion = { question: string; header: string; options: QcmOption[]; multiSelect: boolean }

// ServerEvent (+ sessionId, comme PermissionRequest) :
export type QuestionRequest = { type: 'question_request'; requestId: string; questions: QcmQuestion[] }

// ClientMessage :
// answers ABSENT = « répondu en texte » (dismiss). Présent = Record<question, réponse> ;
// multiSelect : valeurs jointes par ", " ; « Autre » : le texte libre est la valeur.
| { type: 'question_response'; requestId: string; answers?: Record<string, string> }
```

`SERVER_EVENT_TYPES` gagne `'question_request'`, `CLIENT_MESSAGE_TYPES` gagne
`'question_response'`. La docstring de `SessionPermissionMode` est mise à jour :
`'bypassPermissions'` ne mappe plus vers le mode SDK mais vers l'auto-allow sélectif
(le QCM passe toujours).

### 2. Serveur — `apps/server/src/stream/question-broker.ts` (nouveau)

Frère du `PermissionBroker`, même squelette de cycle de vie, sans règles :

- `request(input)` : valide l'input (`questions` = array non vide d'objets portant
  `question`/`header`/`options[]`/`multiSelect`). **Malformé → deny immédiat**
  (« Entrée AskUserQuestion invalide ») sans événement UI — fail closed, le tour
  continue. Valide → publie `question_request` (requestId = `randomUUID()`),
  promesse pending.
- `resolve(requestId, answers)` :
  - `answers` record de strings → settle `{behavior: 'allow', updatedInput:
    {...input, answers}}` (l'input original est conservé tel quel, `answers` ajouté).
  - `answers` absent (clé manquante) → settle `{behavior: 'deny', message:
    "L'utilisateur a répondu directement dans le chat"}`.
  - `answers` présent mais de forme invalide → **no-op**, la requête reste
    pendante et répondable (même politique fail-closed que le `default:` du
    `PermissionBroker.resolve`).
  - requestId inconnu → no-op.
- `pending()` : ré-émission à la reconnexion (ordre d'arrivée).
- `abort()` : deny all (« Session aborted ») — appelé par le message `abort` et
  `dispose()` (suppression de session), comme le broker de permissions.

Le type de retour de `CanUseTool` côté Atelier gagne `updatedInput?:
Record<string, unknown>` sur la branche allow.

### 3. Serveur — routage dans `SessionStream`

```ts
canUseTool: (toolName, input) => {
  if (toolName === 'AskUserQuestion') return this.questions.request(input)
  if (permissionMode === 'bypassPermissions') return Promise.resolve({ behavior: 'allow' })
  return this.broker.request(toolName, input)
}
```

- Le QCM ne passe **jamais** par `ruleMatches`/`deriveProposedRule` : une règle
  « always » existante visant `AskUserQuestion` devient lettre morte (aucune
  migration de données nécessaire).
- `runTurn` ne passe plus `bypassPermissions` à `sdk.runTurn` ; le paramètre et le
  branchement `permissionMode`/`allowDangerouslySkipPermissions` de
  `buildQueryOptions` sont supprimés (le mode est entièrement résolu dans le
  callback ci-dessus).
- `onConnect` ré-émet aussi `questions.pending()` ; `abort`/`dispose` appellent
  `questions.abort()`.
- **Silence du flux outil** : `handleTurnEvent` supprime le broadcast des
  `tool_use`/`tool_result` dont l'outil est `AskUserQuestion` — la carte QCM est la
  représentation du tour ; une ligne outil doublonnerait. (Suppression par
  `toolUseId` mémorisé au `tool_use` pour attraper le `tool_result` apparié.
  `tool_use` porte `toolName` dans `SdkTurnEvent` ; `tool_result` non.)
- **Historique** (rechargement de session) : `describe-tool-use.ts` gagne un cas
  `AskUserQuestion` → `{kind: 'Other', summary: 'QCM : <headers joints>'}` ; la
  carte interactive n'existe qu'en live, l'historique montre cette ligne sobre.

### 4. Seam SDK — `buildQueryOptions`

```ts
if (result.behavior === 'allow') return { behavior: 'allow', updatedInput: result.updatedInput ?? input }
```

Le fallback `?? input` préserve le contrat CLI bundlé (`updatedInput` Zod-requis).

### 5. Web — reducer et contrôleur

- `stream-reducer.ts` : nouveau `ChatItem`
  `{kind: 'question'; requestId; questions: QcmQuestion[]; resolved?: 'answered' | 'dismissed'; answers?: Record<string, string>}`.
  Un `question_request` clôt le run de texte courant (même règle que
  `permission_request`) ; dedup par `requestId` (ré-émission reconnexion).
- `session-controller.ts` :
  - `answerQuestion(requestId, answers)` → envoie `question_response` complet,
    marque l'item `resolved: 'answered'` + `answers` (affichage figé).
  - `sendMessage` : si des items `question` non résolus existent, envoie d'abord
    `question_response` **sans** `answers` pour chacun (marqués
    `resolved: 'dismissed'`), puis file le message comme aujourd'hui — le deny
    dénoue le tour, le message part au settle idle suivant.
- `FixtureSocket` (`backend.ts`) : un fixture scripté `question_request` (2
  questions dont une multiSelect) pour le dev sans SDK et les tests d'App.

### 6. Web — `QuestionPrompt.tsx` (nouveau composant)

Carte inline non-modale dans le fil, même patron a11y que `PermissionPrompt`
(live region `role="alert"` pendant pending, focus parqué sur la carte avant
désactivation, résolution = carte figée dans l'historique) :

- Une section par question : chip `header`, texte de la question, options empilées
  (bouton = label en gras + description en dessous ; `preview` rendu en bloc
  `<code>` sous l'option sélectionnée/survolée), option « Autre… » dépliant un
  champ texte.
- Single-select : boutons radio-like. MultiSelect : cases à cocher.
- **Envoi** : cas mono-question single-select sans « Autre » → le clic envoie
  directement (friction zéro, cas de loin le plus fréquent). Tous les autres cas →
  bouton « Envoyer les réponses » actif quand chaque question a une réponse
  (sélection ou « Autre » non vide).
- Résolue : options choisies mises en évidence, le reste grisé ; dismiss → mention
  « Répondu dans le chat ».

## Interaction avec le mode par défaut (spec 2026-07-31)

Les deux specs composent sans conflit : `default-permission-mode` décide **qui**
choisit `SessionPermissionMode` (gate ou préférence) et le stampe à la création ;
la présente spec redéfinit **comment** `'bypassPermissions'` est appliqué au SDK
(auto-allow sélectif au lieu du mode SDK). Point de contact unique :
`session-stream.ts` lit `permissionMode` — la résolution
`draft ?? permissionModes[id] ?? 'default'` reste inchangée. Les deux chantiers
éditent `protocol.ts` : conflit git trivial (ajouts disjoints).

## Risque principal (à vérifier en implémentation)

L'équivalence **bypass SDK ↔ auto-allow sélectif** n'est pas garantie sur tous les
flux : le vrai `bypassPermissions` peut avoir des effets au-delà de `canUseTool`
(traitement amont de certains outils sensibles, interactions avec le sandbox).
Tâche de vérification obligatoire : un tour réel en skip-permissions exerçant
Bash + Edit + Write doit se dérouler sans prompt ni régression observable, et un
QCM doit remonter dans la même session. Si une divergence bloquante apparaît, le
repli est documenté : conserver le mode SDK en skip-permissions et assumer un QCM
inopérant dans ces sessions uniquement (dégradation locale, pas de régression).

## Cas limites

- **Input malformé** → deny immédiat serveur, aucune carte UI, le tour continue.
- **requestId inconnu / réponse dupliquée** → no-op (resolve one-shot, carte
  désactivée dès résolution).
- **`answers` de forme invalide** → no-op, la question reste répondable.
- **Reconnexion** pendant un QCM → ré-émission `pending()`, dedup reducer ; après
  réponse, la carte vit dans l'état client (un ⌘R en cours de tour la perd — même
  comportement que les cartes permission, assumé).
- **Abort / suppression de session** → deny all via `questions.abort()`.
- **Plusieurs QCM pendants** (le SDK n'en émet normalement qu'un à la fois) : le
  broker gère N pendants ; `sendMessage` les dismisse tous.

## Tests

- `question-broker.test.ts` : allow avec `updatedInput.answers` ; dismiss (answers
  absent) ; answers invalide = no-op ; input malformé = deny immédiat sans sink ;
  pending/ré-émission ; abort ; requestId inconnu.
- `session-stream.test.ts` : routage `AskUserQuestion` → QuestionBroker ; bypass
  sélectif (tout auto-allow SAUF le QCM) ; plus de `bypassPermissions` transmis au
  SDK ; suppression du couple `tool_use`/`tool_result` AskUserQuestion ; ré-émission
  à `onConnect` ; abort/dispose.
- `sdk-client.test.ts` : `buildQueryOptions` fait transiter `result.updatedInput`,
  fallback sur l'input original sinon ; suppression du branchement bypass.
- `describe-tool-use.test.ts` : cas `AskUserQuestion` (résumé historique).
- `stream-reducer.test.ts` : insertion/clôture de run, dedup, résolution.
- `session-controller.test.ts` : `answerQuestion` ; `sendMessage` pendant QCM =
  dismiss de tous les pendants + message en file.
- `QuestionPrompt.test.tsx` : rendu (chips, descriptions, multiSelect, Autre) ;
  envoi direct mono-question ; bouton Envoyer gated ; état résolu/dismissed ; a11y
  (alert pendant pending seulement).
- `App.test.tsx` (fixture) : un tour QCM de bout en bout via `FixtureSocket`.

## Déploiement

Serveur + web : relance de l'app + `bun run build:web` (étages 1-2 du workflow).
`main.ts` (desktop) n'est pas touché — pas de `package:mac`. Bump `version.json`
avec notes FR à la release.
