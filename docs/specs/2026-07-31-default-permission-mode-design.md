# Mode de permissions par défaut — design

Date : 2026-07-31
Statut : validé (brainstorming avec Germain)
Amende : `2026-07-02-atelier-design.md` — la règle « chaque session doit demander » devient le comportement **par défaut**, débrayable via une préférence globale.

## Problème

À chaque nouvelle session, le `PermissionModeGate` bloque le composer jusqu'à un clic
(« Permissions normales » / « Skip permissions »). Pour un usage quotidien où la réponse
est toujours la même, ce clic est de la friction pure. Le choix doit pouvoir devenir
automatique, tout en restant visible et révocable depuis les réglages.

## Décisions

| Question | Décision |
|---|---|
| Capture du défaut | Les deux : checkbox « Se souvenir de ce choix » dans le gate **et** section dans le SettingsPanel |
| Portée | Globale (`Preferences`) — pas de scoping par projet en v0.1.x (YAGNI ; réévaluer avec le multi-projets v0.2) |
| Application | Le serveur stampe le mode à la création de session/draft (approche A) |
| Rétroactivité | Aucune : changer le défaut n'affecte jamais les sessions existantes |
| Sécurité | Indicateur rouge discret quand la session active est en `bypassPermissions` |

### Approches écartées

- **Client auto-répond au gate** : flash du gate possible, aller-retour réseau inutile,
  logique implicite côté UI.
- **Résolution en lecture** (`draft ?? permissionModes[id] ?? preferences.default` dans
  `session-stream.ts`) : une ligne, mais rétroactif — changer le défaut modifierait le mode
  de sessions déjà créées sans réponse enregistrée. Surprenant et dangereux pour un bypass.

## Architecture

### 1. Contrat partagé — `packages/shared/src/protocol.ts`

```ts
export type Preferences = {
  // … champs existants …
  /** Mode appliqué aux nouvelles sessions. Absent/null = demander à chaque session (gate). */
  defaultPermissionMode?: SessionPermissionMode | null
}
```

`SessionPermissionMode` (`'default' | 'bypassPermissions'`) existe déjà ; aucun nouveau type.

### 2. Serveur

- **`routes/settings-routes.ts`** : le PATCH préférences accepte `defaultPermissionMode`,
  validé contre `SESSION_PERMISSION_MODES` ou `null` (effacement → le gate revient).
- **`store/app-data.ts`** : `EMPTY.preferences` gagne `defaultPermissionMode: null`. La
  rétrocompat des `app-data.json` existants est assurée par le **deep-merge par clé** déjà
  en place au load (`preferences: { ...base.preferences, ...parsed.preferences }`) — c'est
  ce merge, et non un spread wholesale, qui injecte le nouveau défaut dans les fichiers
  anciens.
- **`sessions/sessions-service.ts`** : le stamping se fait **uniquement dans
  `createDraft`** — seul point de naissance d'une session Atelier :
  `permissionMode: preferences.defaultPermissionMode ?? null` remplace les **deux** `null`
  codés en dur actuels (le record stocké **et** le `SessionSummary` retourné, qui doivent
  rester cohérents). Le remap draft→réel existant (`mapDraft`) porte déjà ce mode dans
  `permissionModes[sdkSessionId]` ; aucun autre site à toucher. La résolution du mode
  effectif en `session-stream.ts` reste inchangée.
- **Sessions externes** : une session créée hors Atelier (CLI Claude Code directement)
  arrive via `sdk.listSessions` avec `permissionMode: null` et passe donc par le gate même
  quand un défaut est défini — comportement voulu, pas un bug.

### 3. Web — gate (`components/PermissionModeGate.tsx`)

Checkbox « Se souvenir de ce choix » (décochée par défaut). La signature devient
`onChoose(mode, remember)`. Dans `App.tsx`, si `remember` : PATCH session (existant) puis
PATCH préférences `{ defaultPermissionMode: mode }`. Les deux PATCH sont indépendants : si
le PATCH session échoue, le PATCH préférences part quand même (le gate reste alors affiché
pour cette session, les suivantes profiteront du défaut). Le gate continue de s'afficher
pour toute session dont le `permissionMode` est `null` (sessions antérieures, sessions
externes, défaut effacé).

### 4. Web — réglages (`components/SettingsPanel.tsx`)

Nouvelle section « Permissions », au-dessus des règles « toujours autoriser » :

- Trois choix exclusifs : **Demander à chaque session** (= `null`, défaut) /
  **Permissions normales** (`default`) / **Skip permissions (dangereux)**
  (`bypassPermissions`), ce dernier stylé rouge — l'ambre reste réservé aux prompts
  d'outils (charte).
- Mutation optimiste sur la query `['preferences']` avec rollback, comme l'existant.
- Une note indique que le changement ne s'applique qu'aux **nouvelles** sessions.

### 5. Web — indicateur de bypass

Quand la session active est en `bypassPermissions` : puce rouge discrète près du composer
(« Skip permissions »), tooltip « Défini pour cette session — le défaut se gère dans les
réglages ». Aucune donnée nouvelle : le mode de session est déjà connu du client. La puce
s'affiche que le mode vienne du gate ou du défaut.

## Flux

1. **Première session après la feature** : gate affiché → Germain clique « Skip
   permissions » + coche « Se souvenir » → session PATCHée, préférence enregistrée.
2. **Sessions suivantes** : le serveur stampe `bypassPermissions` à la création → pas de
   gate, composer immédiatement actif, puce rouge visible.
3. **Retour en arrière** : réglages → « Demander à chaque session » → les nouvelles
   sessions repassent par le gate. Les sessions existantes gardent leur mode.

## Gestion d'erreurs

- PATCH préférences en échec après « se souvenir » : la session courante a déjà son mode
  (PATCH session indépendant et antérieur) ; erreur signalée via le canal d'erreur
  existant des mutations ; aucun état intermédiaire.
- Valeur inconnue dans le PATCH préférences → 400 (validation contre
  `SESSION_PERMISSION_MODES`).
- `app-data.json` ancien sans le champ → `null` par défaut via `EMPTY` (comportement
  actuel préservé).

## Tests

- **Serveur** : round-trip PATCH/GET préférences (valeurs valides, invalide → 400) ;
  PATCH `defaultPermissionMode: null` **efface** une valeur précédemment définie (piège
  undefined-vs-null du pattern `!== undefined`) ; `createDraft` avec défaut défini →
  `draft.permissionMode` stampé **et** `SessionSummary` retourné cohérent ; défaut `null` →
  `permissionMode: null` (gate) ; remap draft→réel (`mapDraft`) conserve le mode stampé.
- **Web** : gate avec checkbox (choix + se souvenir → deux mutations) ; section réglages
  (sélection, effacement) ; session avec mode déjà défini → pas de gate (pattern
  auto-sélection d'App.test.tsx) ; puce visible en `bypassPermissions`, absente sinon.

## Hors périmètre

- Scoping par projet du défaut (à réévaluer avec le multi-projets v0.2).
- Changement du mode d'une session **en cours** (le gate et le défaut ne concernent que
  l'attribution initiale).
- Tout comptage/télémétrie autour de l'usage du bypass.
