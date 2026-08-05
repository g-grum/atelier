# Autopilot — exécution autonome du backlog (design)

Date : 2026-08-05 · Statut : validé (architecture + cadrage approuvés par Germain, exécution autonome demandée)

## Objectif

Un bouton dans Atelier lance le traitement autonome du backlog : pour chaque issue GitHub labellisée `autopilot`, un agent Claude implémente la feature dans un worktree isolé et ouvre une PR. Rien n'atteint `main` sans review humaine.

## Cadrage (décisions actées)

- **Backlog** : issues GitHub ouvertes labellisées `autopilot`, triées par ancienneté (created asc). Germain cure en labellisant.
- **Autonomie** : l'agent va jusqu'à la PR (`Closes #n`), jamais jusqu'au merge.
- **Exécution** : feature d'Atelier (le serveur orchestre via la machinerie sessions/SDK existante).
- **Déclencheur** : bouton manuel dans un widget dashboard « Autopilot ». Pas de planification (v2 éventuelle).
- **Mode** : séquentiel, borné à `maxItems` par run (défaut 3), un worktree par item, stop propre depuis l'UI.

## Architecture

Nouveau module serveur `apps/server/src/autopilot/` autour d'un service `AutopilotRunner`, injecté dans `createApp` comme les autres services.

### Principe central : un item = un projet temporaire

Le `cwd` d'une session est toujours `project.path` (session-stream.ts → `sdk.runTurn({ cwd: project.path, … })`). Plutôt que d'introduire un override de cwd par session, chaque item crée :

1. un worktree `git worktree add .worktrees/autopilot-<n> -b autopilot/<n>` (`.worktrees/` est déjà gitignoré), suivi d'un **`bun install`** dans le worktree (un worktree vierge n'a pas de `node_modules` — sans ça les gates échouent systématiquement) ;
2. un **projet Atelier** pointant sur le worktree — `Project` n'a **pas** de champ `name` (`{ id, path, color }`, la UI affiche `basename(path)`) : le libellé affiché sera le nom du dossier `autopilot-<n>`, on n'ajoute PAS de champ `name` ;
3. un **draft de session** dans ce projet, `permissionMode` stampé `bypassPermissions` — `createDraft` ne le permet pas (il fige `preferences.defaultPermissionMode`) : le runner appelle `SessionsService.setPermissionMode(draftId, 'bypassPermissions')` juste après la création (seam existant, pas de modif de `createDraft`).

La session est une session Atelier normale : observable en live dans la UI, historique persistant, Stop existant fonctionnel. Aucun champ nouveau sur les sessions ; le lien item↔session vit dans l'état autopilot.

**Remap draft→SDK id** : au premier message, le draft est re-keyé en id SDK réel (`AppData.mapDraft`) et les événements du hub de statut sont publiés sous l'id SDK. Le runner suit le remap **via `data.resolveSessionId` uniquement** (l'événement `mapping` ne part que vers les sockets de session, jamais vers le hub) et met à jour `item.sessionId` — sinon il n'observerait jamais « sa » transition et le lien « ouvrir la session » du widget pointerait sur un draft mort.

### AutopilotRunner

- **État du run** : `idle → running → stopping → idle`. Un seul run actif (démarrage refusé sinon, 409).
- **État d'un item** : `queued → running → pr_opened | failed`.
- **Boucle** : au start, fetch des issues (proxy `gh` existant, nouvelle méthode `listAutopilotIssues(repo, user)` dans `GithubService`), prend les `maxItems` premières, puis traite séquentiellement :
  1. créer worktree + branche + projet + draft ;
  2. pousser le prompt d'item dans le `SessionStream` (`streams.get(id, projectId).onMessage(JSON.stringify({type:'user_message', text}))` — `onMessage` prend une chaîne JSON ; le seam d'abonnement serveur est `onStatusConnect`, un typage dédié côté runner est acceptable) ;
  3. attendre la fin de tour via le hub de statut : transition → `idle` (tour fini) **ou → `error`** (échec SDK : `turn_error` termine en `error` sans passer par `idle` → item `failed` immédiat, pas d'attente du timeout ; si l'erreur est un rate limit avec `resetAt`, le **run entier** s'arrête proprement — inutile d'enchaîner des items sans quota) ;
  4. vérifier la PR : `GithubService.prForBranch(repo, branch, user)` (nouvelle méthode, `gh pr list --head <branch>`, **sans cache** — le cache 60 s de `listPrs` transformerait une PR fraîche en `failed`) ;
  5. PR trouvée → `pr_opened`, item suivant. Pas de PR → **une relance max** (« Termine : gates puis PR ») ; toujours rien après le tour suivant → `failed`, item suivant.
- **Persistance** : nouveau champ `AppDataShape.autopilot` : `{ run: { state, startedAt, maxItems } | null, items: [{ issue, title, branch, projectId, sessionId, prUrl, status, error, startedAt, endedAt }] }` (historique remplacé à chaque run). Pattern `AppData.update` existant.

### Prompt d'item (template serveur)

Gabarit avec le contexte de l'issue (numéro, titre, corps), et les consignes : lis la spec du repo si pertinente, TDD, gates `bun test` + `bun node_modules/typescript/bin/tsc --noEmit -p apps/web`, commits atomiques, `git push -u origin <branche>`, `gh pr create --fill --body "…Closes #<n>"`. Consigne explicite : « tu es autonome, ne pose aucune question, tranche toi-même ».

### Permissions et questions

- Session stampée `bypassPermissions` → auto-allow sélectif existant dans `canUseTool` (session-stream.ts).
- `AskUserQuestion` dans une session autopilot : deny immédiat avec le message « Session autonome — décide seul et continue ». Le `SessionStream` reçoit un prédicat injecté `isAutopilot(sessionId)` **data-driven** (il lit `AppData.autopilot.items` — évite le cycle de construction registry↔runner) pour router ce cas avant le `QuestionBroker`.

### API

- `POST /api/autopilot/start` `{ projectId, maxItems? }` → 202 ou 409 (run en cours) ; projet sans remote GitHub (`projectGithubAccount` → null) → 400 avec message FR. Le repo est dérivé du remote du projet (`git-remote.ts` existant). Le module git utilise son propre runner (le `GitRun` partagé a un timeout 5 s — `worktree add` + `bun install` le dépassent : runner dédié à timeout large).
- `POST /api/autopilot/stop` → passe en `stopping` : l'item courant termine son tour, pas de relance ni d'item suivant, puis `idle`. (Pas d'interrupt brutal en v1 : Stop de la session reste possible manuellement dans la UI.)
- `GET /api/autopilot` → état complet (run + items).
- Événement `autopilot_status` diffusé sur le hub WS de statut existant à chaque transition (le widget écoute au lieu de poller ; fallback refetch au focus comme le widget PRs). Nécessite d'élargir : le type d'événement du hub et son parseur web (`parseSessionStatus` rejette strictement tout sauf `session_status`) dans `protocol.ts`, ET le seam serveur de publication — `SessionStreamRegistry.publishStatus` est privé et ses sinks typés `SessionStatusEvent` (méthode publique de publication ou type de sink élargi, au choix du plan).

### Widget web « Autopilot »

- Nouveau `WidgetType 'autopilot'` (singleton) : seams identiques au widget PRs — `protocol.ts`, `validate-widgets.ts`, `widget-registry.ts`, `renderWidget` dans App.tsx, config `{ projectId, maxItems }` via dialog (pattern `PrConfigDialog`). Attention : `WidgetInstance.config` est aujourd'hui typé dur `{ repo; limit? }` avec validation « absent pour les autres types » — à élargir en union discriminée par type.
- Affiche : état du run, liste des items (issue, titre, statut, lien PR ↗ navigateur système, lien « ouvrir la session » → sélection de la session dans l'app), boutons Lancer/Arrêter.
- Erreurs `gh`/git en FR affichées dans le widget (pattern existant, 502 → message).
- Seam `Backend` étendu (`getAutopilot`, `startAutopilot`, `stopAutopilot`) + fixtures pour le mode démo.

## Gestion d'erreurs

- Échec git (worktree/branche existants, repo sale) → item `failed` avec message FR, run continue.
- Timeout par item : 30 min sans transition terminale → stop de la session (message `{type:'abort'}` du stream — c'est le message existant, pas `stop`) → `failed`.
- Transition → `error` de la session : item `failed` immédiat ; rate limit avec `resetAt` → arrêt propre du run entier (voir Boucle).
- Crash/redémarrage serveur : au boot, un `autopilot.run` non-`idle` est marqué `failed`, et **tous les items non-terminaux** (`queued` comme `running`) passent `failed`. Jamais de reprise aveugle.
- Worktrees et branches des items terminés sont **conservés** pour autopsie. Un bouton « Nettoyer » dans le widget supprime worktree + branche locale + projet Atelier des items en état terminal (la session SDK reste dans `~/.claude/projects`). Ordre : `git worktree remove --force` d'abord (un worktree sale refuse sinon), `git branch -D` (branche non mergée), suppression du projet ensuite (elle ne touche pas au filesystem, donc tolère un chemin disparu).
- Issue fermée entre le fetch et le traitement : l'item est traité quand même (fenêtre courte, YAGNI).

## Tests

- **TDD partout.** Runner et state machine testés avec fake `GhRun`, fake git runner, fake SDK (fixtures existantes) : parcours nominal, pas-de-PR→relance→failed, stop pendant un item, timeout, crash-au-boot, 409.
- Routes autopilot (pattern des tests de routes existants).
- `GithubService.listAutopilotIssues` / `prForBranch` avec fake `GhRun`.
- Widget + Backend fixtures (Testing Library) : rendu des états, Lancer/Arrêter, liens.
- **Vérification finale contre le vrai SDK** : serveur headless sur port isolé (`--port/--token/--data`), une vraie issue de test dans un repo jetable, run complet jusqu'à la PR (pattern QCM v0.1.11).

## Hors périmètre (v2+)

Planification cron, items en parallèle, merge auto, auto-découverte du backlog, reprise d'un run après crash.
