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
- **`store/app-data.ts`** : `EMPTY` gagne `defaultPermissionMode: null`. Le clonage
  wholesale `{ ...EMPTY, ...parsed }` au load garantit la rétrocompat des
  `app-data.json` existants.
- **`sessions/sessions-service.ts`** : à la création d'une session **et** d'un draft, si
  `preferences.defaultPermissionMode` est non-null, le mode est stampé immédiatement
  (`permissionModes[id]` / `draft.permissionMode`). La résolution du mode effectif en
  `session-stream.ts` reste inchangée, de même que le remap draft→réel existant.

### 3. Web — gate (`components/PermissionModeGate.tsx`)

Checkbox « Se souvenir de ce choix » (décochée par défaut). La signature devient
`onChoose(mode, remember)`. Dans `App.tsx`, si `remember` : PATCH session (existant) puis
PATCH préférences `{ defaultPermissionMode: mode }`. Le gate continue de s'afficher pour
toute session dont le `permissionMode` est `null` (sessions antérieures, défaut effacé).

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

- **Serveur** : round-trip PATCH/GET préférences (valeurs valides, `null`, invalide → 400) ;
  création session/draft avec défaut défini → mode stampé ; défaut `null` → pas de stamp ;
  remap draft→réel conserve le mode stampé.
- **Web** : gate avec checkbox (choix + se souvenir → deux mutations) ; section réglages
  (sélection, effacement) ; session avec mode déjà défini → pas de gate (pattern
  auto-sélection d'App.test.tsx) ; puce visible en `bypassPermissions`, absente sinon.

## Hors périmètre

- Scoping par projet du défaut (à réévaluer avec le multi-projets v0.2).
- Changement du mode d'une session **en cours** (le gate et le défaut ne concernent que
  l'attribution initiale).
- Tout comptage/télémétrie autour de l'usage du bypass.
