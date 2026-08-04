# Runner de scripts `package.json` — design

Date: 2026-08-04 · Statut: validé avec le propriétaire (Germain) en brainstorming.

## Problème

Atelier pilote des sessions d'agent, mais pour lancer les scripts du projet
(`test`, `build`, `lint`) il faut sortir de l'app et passer au terminal. Le seul
chemin d'exécution shell existant est l'outil Bash **du modèle**, soumis au
`permission-broker` — rien ne permet à l'utilisateur de lancer lui-même un
script.

Germain veut **cliquer sur un script et voir sa sortie défiler en direct**.

Cette spec est le second volet d'une demande découpée en deux ; le premier
(slash commands) est livré — voir `docs/specs/2026-07-31-slash-commands-design.md`.

## Décisions

1. **One-shot uniquement** (`test`, `build`, `lint`) — **pas** de serveur `dev`
   ni de `--watch`. Les process persistants (orphelins, réattachement après
   rechargement de l'UI) concentrent toute la complexité, pour un usage mieux
   servi par un terminal.
2. **Sortie streamée en direct**, pas bufferisée. Mesuré sur ce repo :
   `build:web` prend ~2–7 s mais `bun test` ~38 s — 38 s de silence serait
   inacceptable.
3. **Transport : SSE.** La sortie est strictement unidirectionnelle
   serveur→client, ce qui est exactement la forme de SSE ; Hono fournit
   `streamSSE`.
4. **Surface : un widget du dashboard**, avec une **modale** pour la sortie
   complète. Le widget s'insère dans le système existant ; la modale évite
   d'entasser 38 s de log dans une tuile à hauteur figée.
5. **Aucun passage par le système de permissions.** C'est l'utilisateur qui
   clique sur un script qu'il a lui-même écrit. Voir § Sécurité — c'est un choix
   explicite, pas un oubli.
6. **Un run à la fois par projet** ; un second départ renvoie `409`.
7. **Scripts découverts** depuis le `package.json` du projet — pas de liste
   configurée à la main.

### Approches écartées

- **Sortie bufferisée** (`await` puis affichage, modèle `gh-runner`) : plus
  simple, mais laisse `bun test` muet 38 s.
- **Étendre le WebSocket à la portée projet** (`/ws/project/:id` + registre
  calqué sur `SessionStreamRegistry`) : réutilise un motif éprouvé, mais monte
  toute une infrastructure de stream **bidirectionnelle** en double pour un
  besoin qui ne l'est pas.
- **Polling REST incrémental** : aucun transport nouveau, le plus simple à
  tester, mais ~76 requêtes pour un run de 38 s et une latence visible — on
  paierait le polling durablement pour économiser peu.
- **Sortie dans le chat** : zéro nouvelle surface, mais pollue l'historique
  conversationnel avec du log de build, et le chat est **par session** alors que
  les scripts sont **par projet**.

## Constat de l'existant

- **Aucun précédent de streaming HTTP** côté serveur : le seul motif de
  subprocess est `gh-runner.ts`, **bufferisé** avec un timeout de 10 s
  (`gh-runner.ts:4`) — inutilisable tel quel pour un run de 38 s.
- **Le WebSocket est par session** (`app.ts:73`, `/ws/:id?projectId=`), pas par
  projet : un runner de scripts ne s'y branche pas naturellement.
- **Piège PATH documenté** : `gh-runner.ts:10` résout `gh` via `Bun.which` avec
  un repli Homebrew, parce qu'un lancement depuis le Dock donne un PATH minimal.
  Le binaire du gestionnaire de paquets se résout de la même façon — sans ça,
  Atelier lancé depuis le Dock ne trouvera pas `bun`.
- Le système de widgets (`WIDGET_META`, `WidgetType`, `SINGLETON_WIDGET_TYPES`)
  et `components/ui/dialog` existent déjà.

## Architecture

### 1. Contrat partagé — `packages/shared/src/protocol.ts`

```ts
export type ScriptInfo = { name: string; command: string }
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
export type RunSummary = {
  id: string
  projectId: string
  script: string
  status: RunStatus
  /** null tant que le run tourne, ou s'il a été tué. */
  exitCode: number | null
  startedAt: string
  endedAt?: string
}
/** Charge utile SSE. `line` par ligne de sortie, `end` une fois en fin de run. */
export type RunEvent =
  | { type: 'line'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'end'; status: RunStatus; exitCode: number | null }
```

Ajouter `'scripts'` à `WidgetType` et à `SINGLETON_WIDGET_TYPES` (un seul widget
scripts par dashboard).

`ServerEvent` et `ClientMessage` sont **inchangés** : le runner ne passe pas par
le WebSocket de session.

### 2. Serveur — `scripts/split-lines.ts` (PUR)

```ts
/** Découpe un chunk en lignes complètes + le reste incomplet à reporter. */
export function splitLines(rest: string, chunk: string): { lines: string[]; rest: string }
```

Un chunk de `stdout` peut couper une ligne en deux — c'est le bug classique de ce
genre de code. Gère `\n` et `\r\n` ; la dernière ligne sans `\n` final reste dans
`rest` jusqu'à la fermeture du flux.

### 3. Serveur — `scripts/discover-scripts.ts` (PUR)

`package.json` → `ScriptInfo[]`. Couture fs injectable (modèle `GhRun`).
Contrat **ne-jette-jamais** (modèle `deriveMessageCount`,
`sdk-client.ts:387-397`) : fichier absent, JSON malformé, `scripts` absent ou
non-objet → `[]`.

### 4. Serveur — `scripts/detect-package-manager.ts` (PUR)

Lockfile présent → `'bun' | 'pnpm' | 'npm' | 'yarn'` ; aucun → `'bun'` par
défaut.

**Ajouté délibérément contre le YAGNI :** Atelier gère aussi des projets non-bun
(`demoapp-frontend`), et lancer `bun run` sur un projet npm est un échec
silencieux garanti. Dix lignes, entièrement testable.

### 5. Serveur — `scripts/run-registry.ts`

Possède les process en cours et les tampons de sortie.

| Méthode | Rôle |
|---|---|
| `start(project, script)` | Lance ; renvoie `RunSummary`, ou refuse si un run tourne déjà pour ce projet |
| `get(runId)` | `RunSummary` + tampon complet (alimente la modale après rechargement) |
| `subscribe(runId, sink)` | Rejoue le tampon puis pousse les `RunEvent` suivants ; renvoie un désabonnement |
| `cancel(runId)` | `proc.kill()` → `status: 'cancelled'` |

- **Couture de spawn injectable** (modèle `GhRun`, `gh-runner.ts:2`) pour que
  les tests ne lancent aucun process.
- **Résolution du binaire** via `Bun.which` + repli, comme `gh-runner.ts:10`.
  Introuvable → une ligne `stderr` explicite avec la commande d'installation et
  `exitCode: 127`, exactement le motif de `gh-runner.ts:23`.
- **Tampon borné aux 5 000 dernières lignes**, avec une ligne de marqueur de
  troncature — un run bavard ne doit pas faire fuir la mémoire.
- **Pas de timeout.** Contrairement à `gh-runner` (10 s), un `test` légitime dure
  des dizaines de secondes ; l'utilisateur dispose de **Stop**.
- Sortie conservée après la fin (mémoire seulement, perdue au redémarrage).

### 6. Serveur — `scripts/scripts-routes.ts`

| Méthode | Chemin | Rôle |
|---|---|---|
| `GET` | `/projects/:id/scripts` | Liste découverte |
| `POST` | `/projects/:id/runs` | Démarre → `RunSummary` (`409` si occupé) |
| `GET` | `/runs/:runId/stream` | SSE des `RunEvent` |
| `POST` | `/runs/:runId/cancel` | Annule |
| `GET` | `/runs/:runId` | Résumé + tampon (modale, reconnexion) |

Résolution de l'id de projet : **aucun résolveur partagé n'existe au HEAD** —
`sessions-routes.ts:12` et `github-routes.ts:17` inlinent chacun leur
`projects.find`. On fait de même, `404` sur projet inconnu. Conséquence assumée :
un id de worktree (`wt:`) n'est pas supporté tant que le plan worktrees n'a pas
atterri.

### 7. Web — widget `scripts` + modale

- Widget : un bouton par script, badge d'état du dernier run
  (en cours / succès / échec), bouton **Stop** pendant l'exécution, boutons
  désactivés tant qu'un run tourne.
- Clic sur le badge → **modale** (`components/ui/dialog`) : sortie complète,
  `stderr` visuellement distinct de `stdout`, autoscroll en bas.
- Le flux SSE est consommé via `EventSource` ; à l'ouverture de la modale après
  un rechargement, `GET /runs/:runId` fournit le tampon.
- Couleurs : vert/rouge selon l'issue ; **l'ambre reste réservé aux
  permissions**.

## Flux

1. Le widget monte → `GET /projects/:id/scripts` → boutons.
2. Clic sur `test` → `POST /projects/:id/runs` → `RunSummary` (`status: 'running'`).
3. Le client ouvre `GET /runs/:runId/stream` → `line` au fil de l'eau, puis `end`.
4. Le widget passe le badge en vert/rouge selon `end.status`.
5. Clic sur le badge → modale, tampon complet.
6. **Stop** → `POST /runs/:runId/cancel` → `end` avec `status: 'cancelled'`.

## Sécurité — un choix explicite

Ce runner crée une **seconde voie d'exécution shell** dans Atelier, **non
soumise au `permission-broker`**. C'est délibéré et borné :

- L'origine est **humaine** (un clic), pas un modèle proposant une commande.
- Les commandes exécutables sont **exactement** celles du `package.json` du
  projet enregistré — pas de saisie libre, pas d'arguments arbitraires.
- Le `cwd` est le chemin du projet enregistré.

Le `permission-broker` reste intégralement réservé aux outils de l'agent. Si un
jour de la saisie libre est ajoutée (un vrai terminal), cette décision devra être
rouverte — ce serait alors une surface d'exécution arbitraire.

## Gestion d'erreurs

| Cas | Comportement |
|---|---|
| `package.json` absent ou malformé | Widget « aucun script », pas d'erreur |
| Gestionnaire de paquets introuvable (PATH) | Ligne `stderr` avec la commande d'installation, `exitCode: 127` |
| Run déjà en cours pour ce projet | `409` (les boutons sont de toute façon désactivés) |
| Flux SSE coupé | Reconnexion ; `GET /runs/:runId` rejoue le tampon — rien n'est perdu |
| `runId` inconnu | `404` |
| Script en échec | `status: 'failed'` + exit code affiché. **Pas une erreur d'Atelier** — aucune bannière |
| Sortie > 5 000 lignes | Tampon tronqué par le début, marqueur visible |
| Projet inconnu | `404`, comme les routes voisines |

## Tests

L'essentiel est en unités **pures**, sans process ni SSE :

- **`split-lines.test.ts`** — chunk coupant une ligne en deux ; `\r\n` ; chunk
  final sans `\n` ; chunk vide ; plusieurs lignes d'un coup.
- **`discover-scripts.test.ts`** — fichier absent ; JSON malformé ; `scripts`
  absent ; `scripts` non-objet ; cas nominal.
- **`detect-package-manager.test.ts`** — les 4 lockfiles ; aucun → `'bun'`.
- **`run-registry.test.ts`** (spawn factice) — `start` renvoie un `RunSummary`
  `running` ; `subscribe` rejoue le tampon **puis** reçoit les lignes suivantes ;
  `end` porte le bon `status`/`exitCode` ; second `start` refusé ; `cancel` →
  `'cancelled'` ; troncature à 5 000 lignes ; binaire introuvable → `stderr` +
  `127`.
- **`scripts-routes.test.ts`** — `200` liste ; `404` projet inconnu ; `409` run
  en cours ; `404` `runId` inconnu ; le SSE émet bien `line` puis `end`.
- **`ScriptsWidget.test.tsx`** — un bouton par script ; boutons désactivés
  pendant un run ; **Stop** visible seulement pendant ; clic sur le badge ouvre
  la modale ; liste vide → message « aucun script ».

## Hors périmètre

- **Serveur `dev` / `--watch`** et tout process persistant (décision 1).
- **Runs concurrents** sur un même projet (décision 6).
- **Historique persisté** des runs — mémoire seulement, perdu au redémarrage.
- **Variables d'environnement personnalisées** par script.
- **Saisie libre de commandes** (un vrai terminal) — rouvrirait la décision de
  sécurité.
- **Support des ids de worktree** — suit le plan worktrees.
