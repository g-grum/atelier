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
- **Le WebSocket est par session** (`app.ts:73`, route réelle `/api/sessions/:id/stream`), pas par
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

**Deux pièges silencieux — le type partagé ne les force PAS :**

1. `apps/web/src/components/widgets/widget-registry.ts` — `WIDGET_META` est un
   `Partial<Record<WidgetType, WidgetMeta>>`. Le menu « + Widget » de
   `DashboardGrid.tsx:52` et son `add(type)` (`:38`, qui no-op silencieusement sur
   `undefined`) sont **entièrement** pilotés par cette map : sans entrée,
   **aucun chemin UI ne permet jamais d'ajouter le widget**. Pas d'erreur, juste
   impossible.
2. `apps/server/src/routes/validate-widgets.ts` — `TYPES` est un
   `Set<WidgetType>` **maintenu à la main**, pas dérivé de l'union. Sans ajout,
   `PUT /api/widgets` renvoie `400 « type inconnu « scripts » »` alors que tout
   le reste est câblé.

Même classe de piège que le `Set` `SERVER_EVENT_TYPES` de la spec slash
commands : un type ajouté sans son entrée de registre échoue sans bruit.

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
`sdk-client.ts:449-463`) : fichier absent, JSON malformé, `scripts` absent ou
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
- **Résolution du binaire** dans sa propre fonction pure (même discipline que
  les trois autres unités, donc testable sans couture de spawn) :
  - **`bun` → `process.execPath`.** Le serveur *est déjà* lancé par
    `apps/desktop/src/main.ts` avec le `bunPath` correctement résolu par
    `resolveRuntime()`, précisément pour survivre au PATH minimal du Dock.
    Un repli devinant `/opt/homebrew/bin/bun` échouerait sur une installation via
    l'installeur officiel (`~/.bun/bin/bun`, au moins aussi courante) — c'est-à-dire
    dans le scénario même qu'il prétend couvrir.
  - **`npm`/`pnpm`/`yarn` → `Bun.which` + repli Homebrew**, comme
    `gh-runner.ts:10`.
  - Introuvable → une ligne `stderr` explicite avec la commande d'installation et
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
| `GET` | `/projects/:id/runs/latest` | `RunSummary \| null` — dernier run de ce projet |

**`/projects/:id/runs/latest` est indispensable, pas un confort :** sans elle, un
rechargement de l'onglet pendant un run laisse le widget incapable de retrouver
le `runId` en cours. Le badge « en cours » et l'invariant « boutons désactivés
tant qu'un run tourne » (décision 6) ne seraient restaurables que dans la session
de navigateur qui a lancé le run. Elle sert aussi le badge du **dernier** résultat
au montage du widget.

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
- Le flux SSE est consommé via `EventSource`, **avec le token en query string**
  (`?token=`) : `/api/*` exige une authentification et un `EventSource` ne peut
  pas poser d'en-tête. C'est exactement ce que font déjà les deux clients WS
  (`api/ws.ts:68`, `status-socket.ts:35`) via `getToken()`. Sans ça, `401` au
  premier essai.
- Au montage, `GET /projects/:id/runs/latest` restaure le badge (et le `runId`
  d'un run encore en cours après rechargement) ; à l'ouverture de la modale,
  `GET /runs/:runId` fournit le tampon.
- Couleurs : vert/rouge selon l'issue ; **l'ambre reste réservé aux
  permissions**.

## Flux

1. Le widget monte → `GET /projects/:id/scripts` → boutons.
2. Clic sur `test` → `POST /projects/:id/runs` → `RunSummary` (`status: 'running'`).
3. Le client ouvre `GET /runs/:runId/stream` → `line` au fil de l'eau, puis `end`.
4. Le widget passe le badge en vert/rouge selon `end.status`.
5. Clic sur le badge → modale, tampon complet.
6. **Stop** → `POST /runs/:runId/cancel` → `end` avec `status: 'cancelled'`.

## Sécurité — un choix explicite, avec un risque résiduel nommé

Ce runner crée une **seconde voie d'exécution shell** dans Atelier, **non
soumise au `permission-broker`**. C'est délibéré :

- L'origine est **humaine** (un clic), pas un modèle proposant une commande.
- Il n'y a **pas de saisie libre** : seules les entrées de `scripts` du
  `package.json` sont lançables, sans arguments ajoutés.
- Le `cwd` est le chemin du projet enregistré.

### Le chemin « confused deputy » — à ne pas cacher

La borne « ce sont les commandes du `package.json` » ne suffit **pas** à fermer
la frontière de confiance : `package.json` est un fichier ordinaire du projet,
donc **éditable par les outils de fichiers de l'agent**. Ces éditions passent par
le `permission-broker` — mais une décision `'always'` **persiste une règle** qui
auto-autorise silencieusement les éditions suivantes
(`permission-broker.ts:34-38` pour l'auto-autorisation silencieuse, `:63-67` pour la persistance de la règle). Une fois une telle règle accordée pour les
fichiers du projet (grant courant et plausible), l'agent peut réécrire la
commande d'un script, qui s'exécutera ensuite **sans aucun contrôle** au prochain
clic humain.

**Mitigation retenue :** le widget **affiche la commande réelle** de chaque
script (c'est la raison d'être de `ScriptInfo.command`), et non seulement son
nom. L'humain voit donc ce qu'il lance : un `test` devenu `rm -rf …` est visible
avant le clic. C'est une mitigation par **transparence**, pas un contrôle
d'accès.

**Risque résiduel assumé :** un humain qui clique sans lire reste exposé. Fermer
réellement la frontière demanderait soit de faire passer les runs par le
`permission-broker` (ce qui annule l'intérêt du « un clic »), soit d'épingler une
empreinte des scripts et d'alerter au changement — reporté, non retenu pour cette
version. Décision consciente, à rouvrir si de la saisie libre est ajoutée (un
vrai terminal serait une surface d'exécution arbitraire, pas la même discussion).

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
- **`resolve-runner-binary.test.ts`** — `bun` → `process.execPath` ;
  `npm`/`pnpm`/`yarn` → chemin trouvé par `Bun.which` ; repli Homebrew quand `Bun.which` échoue ; introuvable partout → `null`.
- **`scripts-routes.test.ts`** — `200` liste ; `404` projet inconnu ; `409` run
  en cours ; `404` `runId` inconnu ; le SSE émet bien `line` puis `end` ;
  `/projects/:id/runs/latest` renvoie le run en cours, puis le dernier terminé,
  puis `null` quand il n'y en a jamais eu.
- **`ScriptsWidget.test.tsx`** — un bouton par script ; **la commande réelle est
  affichée** (mitigation de sécurité, pas seulement le nom) ; boutons désactivés
  pendant un run ; **Stop** visible seulement pendant ; clic sur le badge ouvre
  la modale ; liste vide → message « aucun script » ; au montage,
  `runs/latest` restaure un badge « en cours » (cas du rechargement d'onglet).

## Hors périmètre

- **Serveur `dev` / `--watch`** et tout process persistant (décision 1).
- **Runs concurrents** sur un même projet (décision 6).
- **Historique persisté** des runs — mémoire seulement, perdu au redémarrage.
- **Variables d'environnement personnalisées** par script.
- **Saisie libre de commandes** (un vrai terminal) — rouvrirait la décision de
  sécurité.
- **Support des ids de worktree** — suit le plan worktrees.
