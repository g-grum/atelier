# Slash commands dans le composer — design

Date: 2026-07-31 · Statut: validé avec le propriétaire (Germain) en brainstorming, puis révisé après spikes.

## Problème

Atelier est un client du Claude Agent SDK, mais il n'expose aucune des **slash
commands** que Claude Code offre : ni les commandes de projet
(`.claude/commands/*.md`), ni les natives (`/compact`, `/usage`), ni celles des
plugins et skills. Aujourd'hui le composer n'envoie que du texte brut
(`Composer.tsx:40-47`), sans découverte ni autocomplétion.

Germain veut pouvoir **taper `/review` dans le composer, avec autocomplétion**,
et que la commande s'exécute.

Cette spec ne couvre **que** les slash commands. Le second besoin exprimé
— lancer les scripts du `package.json` en un clic — est un sous-système
indépendant (exécution shell, surface UI distincte, code partagé quasi nul) et
fera l'objet de sa propre spec.

## Décisions

1. **L'exécution est gratuite — aucun chemin nouveau.** L'utilisateur choisit
   `/review`, le composer insère le texte, `Enter` envoie un `user_message`
   ordinaire, le serveur passe le prompt **inchangé** au SDK, et le CLI
   l'expanse. Tout le travail de cette spec est dans la *découverte* et
   l'*autocomplétion*.
2. **Une seule source : le SDK.** La liste vient de `supportedCommands()`,
   obtenue via une sonde jetable à l'ouverture de session (approche D, validée
   par spike) et rafraîchie par `commands_changed`. **Aucun parsing de fichiers
   `.md` par Atelier.**
3. **Filtrage sur `name` ET `aliases`.** La quasi-totalité des commandes réelles
   sont namespacées (`superpowers:brainstorming`) et ne se tapent en pratique
   que par leur alias court (`brainstorming`).
4. **Pas de validation des commandes inconnues.** `/nope` part tel quel ; c'est
   le CLI qui répond.
5. **Tout dégrade en silence.** L'autocomplétion est un confort ; aucun de ses
   échecs ne doit gêner l'envoi d'un message ni afficher de bannière d'erreur.
6. **Liste clefée par projet** (elle dépend du `cwd`), mise en cache côté client.

### Approches écartées

- **A — SDK seul, paresseux** (sonde uniquement pendant le tour). Rejeté : sur
  une session neuve, aucune commande avant le premier tour, or c'est
  précisément là qu'on veut taper `/review`.
- **B / C — scan disque de `.claude/commands/`**, seul ou hybridé avec le SDK.
  **Rejeté sur mesure** (voir § Spikes) : sur le poste de Germain il n'existe
  aucun `.claude/commands/` — ni dans le repo, ni dans `~/.claude/` — et les 30
  fichiers de commandes présents sont tous sous `~/.claude/plugins/`. Un scan
  disque tel que spécifié aurait livré une liste **vide** au jour 1, là où le
  SDK en renvoie 68. Le parser, sa gestion de frontmatter, sa précédence
  projet > user et la réconciliation à deux sources disparaissent tous avec ce
  choix.

## Constat SDK (vérifié dans `sdk.d.ts` 0.3.198 + mesuré par spike)

- `SlashCommand = { name, description, argumentHint, aliases, … }`
  (`sdk.d.ts:6242`) — `name` est **sans** le slash initial.
- `supportedCommands(): Promise<SlashCommand[]>` (`sdk.d.ts:2323`) est une
  méthode de l'objet `Query`, donc disponible **seulement pendant un tour** :
  c'est ce qui impose la sonde jetable plutôt qu'un simple appel.
- `SDKCommandsChangedMessage` (`sdk.d.ts:2782-2788`, doc en `2780`) :
  `type: 'system'`, `subtype: 'commands_changed'`, `commands`. La doc est
  explicite — les clients doivent **REMPLACER** leur liste en cache, car
  `supportedCommands()` est capturé une fois à l'`initialize` et ne reflète
  jamais les changements en cours de session. Ce message est bien dans l'union
  `SDKMessage` (`sdk.d.ts:3736`), donc le narrowing
  `msg.type === 'system' && msg.subtype === 'commands_changed'` type-checke.
- **`settingSources` omis = toutes les sources chargées** (`sdk.d.ts:1836-1846`,
  « Must include `'project'` to load CLAUDE.md files »).
  `buildQueryOptions` (`sdk-client.ts:243-260`) ne le passe pas : rien à
  changer — et il faut **veiller à ne pas introduire** de `settingSources`
  restrictif, qui désactiverait silencieusement les commandes de projet.
- **Descriptions déjà annotées de leur portée** par le SDK : `"… (project)"`,
  `"(superpowers) …"`. Atelier les affiche telles quelles et **ne re-dérive pas**
  la portée.
- `argumentHint` n'est renseigné que sur **20 des 68** commandes observées → il
  est souvent la chaîne vide, l'UI doit le gérer.

## Architecture

### 1. Contrat partagé — `packages/shared/src/protocol.ts`

`protocol.ts` est aujourd'hui totalement dépendance-free ; on définit **notre
propre type** plutôt que d'importer celui du SDK, pour ne pas y faire entrer le
SDK.

```ts
/**
 * Une slash command proposée à l'autocomplétion. `name` est sans le slash
 * initial (contrat SDK). `aliases` porte les noms courts des commandes
 * namespacées (`superpowers:brainstorming` → `brainstorming`) : le filtrage
 * doit les inclure, sinon les commandes de plugins sont introuvables.
 */
export type SlashCommandInfo = { name: string; description: string; argumentHint: string; aliases: string[] }
```

Nouvelle variante de `ServerEvent` (`protocol.ts:110-117`) :

```ts
| { type: 'commands'; sessionId: string; commands: SlashCommandInfo[] }
```

**Piège à ne pas manquer :** ajouter `'commands'` au `Set` `SERVER_EVENT_TYPES`
(`protocol.ts:119`). `isServerEvent` filtre sur ce `Set` explicite — un type
ajouté sans son entrée serait silencieusement jeté côté client, sans erreur.

`ClientMessage` (`protocol.ts:95-98`) est **inchangé** : une slash command part
comme un `user_message` normal (décision 1).

### 2. Serveur — sonde de découverte (`apps/server/src/sdk/sdk-client.ts`)

L'interface `SdkClient` (`sdk-client.ts:44-50`) gagne une méthode :

```ts
listCommands(cwd: string): Promise<SlashCommandInfo[]>
```

Implémentation : un `query()` jetable avec un `AbortController`, itéré jusqu'au
message `system`/`init`, puis `await q.supportedCommands()`, puis `abort()`
immédiat. Aucun message n'est jamais envoyé au modèle, et le spike confirme
qu'**aucun transcript de session n'est créé**.

- Contrat **ne-jette-jamais** (modèle `deriveMessageCount`,
  `sdk-client.ts:387-397`) : toute défaillance → `[]`.
- Le mapping `SlashCommand → SlashCommandInfo` est une fonction **pure
  exportée**, couture testable pour un contrat de frontière que le mock ne voit
  pas — même justification que `mapUsageWindows` et `buildQueryOptions`.
- `sdk-client.mock.ts` implémente la méthode.

**Coût mesuré : ~3,8 s** (init ~1,8 s, puis `supportedCommands()` ~2 s). C'est
pourquoi l'appel est asynchrone et non bloquant (§6) : le composer est
utilisable immédiatement, l'autocomplétion s'active quand la liste arrive.

### 3. Serveur — `apps/server/src/commands/commands-routes.ts`

`GET /api/projects/:id/commands` → `SlashCommandInfo[]`. Monté auprès des autres
routes (`app.ts:37-39`).

Résolution de l'id vers un chemin : **il n'existe aucun résolveur partagé au
HEAD** — `sessions-routes.ts:12` et `github-routes.ts:17` inlinent chacun leur
`data.get().projects.find(p => p.id === id)`. Cette route fait de même, et
renvoie **404** sur projet inconnu, cohérent avec ses voisines.

Conséquence assumée : un id de **worktree** (`wt:`) n'est pas supporté. Le
résolveur `resolveWorkspacePath` n'existe que dans
`docs/plans/2026-07-24-worktrees-navigation.md`, dont **aucune tâche n'est
faite**. Quand ce plan atterrira, cette route sera à élargir comme les cinq
autres sites qu'il inventorie — elle est simplement un sixième site du même
type, pas un travail nouveau.

### 4. Serveur — rafraîchissement en cours de session

Dans `runTurn` (`sdk-client.ts:88`), un `SdkTurnEvent` de plus
(`sdk-client.ts:21-29`) :

```ts
| { type: 'commands'; commands: SlashCommandInfo[] }
```

Émis sur `system` / `subtype === 'commands_changed'` dans la boucle de messages,
puis `continue` — le bloc `system`/`init` existant (`sdk-client.ts:104-121`) est
le précédent direct de ce motif.

**On n'ajoute pas de sonde `supportedCommands()` à l'init du tour.** La liste est
déjà connue via §2/§3, et le bloc `init` `await`e déjà la sonde `usage` avant le
premier delta : une seconde sonde séquentielle de ~2 s retarderait le premier
token de chaque tour.

`handleTurnEvent` (`session-stream.ts:177`) relaie l'événement en `ServerEvent`
`commands` avec le `sessionId`, via le `broadcast` existant. Aucune interaction
avec l'invariant un-tour-par-session ni avec la logique owner-only de `runTurn`.

### 5. Web — état et cache

- `GET /api/projects/:id/commands` via **React Query**, clefé par projet, avec
  un `staleTime` long (la liste ne bouge quasiment jamais) : le coût de ~3,8 s
  est payé **une fois par projet** pour la durée de vie de l'app, et un
  aller-retour entre projets ne le repaie pas.
- Le `stream-reducer` stocke `commands: SlashCommandInfo[] | null`
  (`null` = jamais reçu) sur l'événement WS `commands`.
- Le composer lit **`wsCommands ?? restCommands`** : précédence, pas de fusion.
  Les deux venant du **même** producteur (le SDK), il n'y a aucune divergence
  possible entre elles — le `commands_changed` est simplement plus frais.

**Comportement assumé et documenté :** l'état du `stream-reducer` est
par-session et reconstruit par `reset(history)` à l'ouverture d'une session
**et à chaque resync de reconnexion**. Un `commands` reçu est donc perdu dans ces
cas, et l'UI retombe sur la liste React Query — qui, elle, survit (clefée par
projet). C'est acceptable : la liste REST est de la même origine, seulement plus
ancienne. Ce n'est pas un bug à « corriger » à l'implémentation.

### 6. Web — autocomplétion (`components/Composer.tsx`)

`ComposerProps` (`Composer.tsx:4-13`) gagne une prop explicite, pour que l'unité
reste testable isolément :

```ts
/** Liste pour l'autocomplétion. Vide ⇒ aucun popover (dégradation silencieuse). */
commands: SlashCommandInfo[]
```

**Déclenchement volontairement strict :** le popover n'apparaît que si le
brouillon **commence** par `/` (position 0) et que le curseur est encore dans le
premier mot. Sinon `src/foo` ou une URL déclencherait l'autocomplétion en pleine
phrase.

**Filtrage** par préfixe sur `name` **et** sur chaque entrée de `aliases`
(décision 3). Affichage : `name`, `description`, `argumentHint` quand il est non
vide.

**Complétion : le premier token seulement.** `Enter` remplace le token de
commande par `/nom ` et **préserve le reste du brouillon** ainsi que la position
du curseur (placé après l'espace inséré). Une réécriture du brouillon entier
perdrait l'argument déjà tapé — cas réel, puisque le curseur peut revenir dans
`review` sur `/review mon-fichier`.

**Zéro résultat ⇒ popover fermé.** Sans cette règle, taper `/nope` (le cas de la
décision 4) laisserait `Enter` « compléter rien » au lieu d'envoyer — un blocage
d'envoi dans le flux même que la décision 4 promet de faire marcher.

Clavier — le conflit central est que `Enter` envoie aujourd'hui le message
(`Composer.tsx:60-66`) :

| Touche | Popover ouvert (≥1 résultat) | Popover fermé (dont 0 résultat) |
|---|---|---|
| `↑` `↓` | navigue dans la liste | comportement actuel |
| `Enter` / `Tab` | complète en `/nom ` | **envoie** |
| `Esc` | ferme, garde le texte | — |
| `⌘↵` | **envoie toujours** | envoie |

`⌘↵` conserve son échappatoire inconditionnelle. Sélection à la souris
également.

**Le popover est écrit à la main** : `components/ui/` n'a que button, dialog,
dropdown-menu, input, sonner, tooltip — pas de primitive listbox. Donc
`role="listbox"` / `role="option"` + `aria-activedescendant` à la main, avec
`scrollIntoView` sur la navigation clavier.

## Flux

1. Ouverture de session → `GET /api/projects/:id/commands` → sonde SDK jetable
   (~3,8 s, non bloquant) → liste des 68 commandes en cache React Query.
2. L'utilisateur tape `/` → popover, filtré à la frappe sur `name` + `aliases`.
3. `Enter` → le premier token devient `/review `, le reste du brouillon est
   préservé, le popover se ferme.
4. `Enter` (popover fermé) ou `⌘↵` → `user_message` `/review` → `runTurn` passe
   le prompt **inchangé** au SDK → le CLI expanse la commande.
5. Découverte dynamique en cours de session → `commands_changed` → `ServerEvent`
   `commands` → le reducer remplace la liste.

## Gestion d'erreurs

| Cas | Comportement |
|---|---|
| REST en échec / sonde en échec | Liste vide. Pas d'autocomplétion, **aucune bannière**. Le composer reste pleinement utilisable — `/review` peut être tapé à la main. |
| Sonde lente (~4 s) | Le composer fonctionne pendant ce temps ; l'autocomplétion s'active à l'arrivée de la liste. |
| Liste vide | Pas de popover. |
| Zéro résultat pour le préfixe | Popover fermé ⇒ `Enter` **envoie**. |
| Commande inconnue envoyée | Transmise telle quelle ; c'est le CLI qui répond (décision 4). |
| Projet inconnu sur la route | 404, comme ses voisines. |
| Id de worktree (`wt:`) | 404 — non supporté tant que le plan worktrees n'a pas atterri (§3). |
| Resync WS / changement de session | La liste WS est perdue, retour à la liste REST (§5) — pas une erreur. |
| Changement de projet | Nouvelle entrée de cache React Query, clefée par projet. |

## Spikes — faits, résultats intégrés

Les deux questions ouvertes de la première rédaction ont été **mesurées** ; leurs
réponses sont déjà intégrées ci-dessus. Aucun spike ne reste à faire.

1. **Namespacing et frontmatter** — un sous-dossier donne bien un nom à
   deux-points : `.claude/commands/git/pr.md` → **`git:pr`**. Les clés
   `description` et `argument-hint` sont lues et remontent dans
   `description` / `argumentHint`.
2. **Approche D (sonde jetable)** — **aucune session fantôme** : le dossier de
   transcript reste absent après la sonde. La liste renvoyée contient les
   commandes de projet (`spike-review`), les imbriquées (`git:pr`), celles des
   plugins (`superpowers:*`) et les natives (`compact`, `usage`, `clear`,
   `init`, `review`, `agents`, `context`) — **68 au total**, contre **0** pour un
   scan disque sur ce poste. Coût : ~3,8 s, d'où le cache de §5.

## Tests

- **`sdk-client.test.ts`** — mapping `SlashCommand → SlashCommandInfo` (dont
  `aliases` et `argumentHint` vide) ; `listCommands` renvoie `[]` sur échec
  (ne-jette-jamais) ; émission de l'événement sur `commands_changed`.
- **`commands-routes.test.ts`** — 200 avec liste ; 404 projet inconnu ; 200 avec
  `[]` quand la sonde échoue.
- **`session-stream.test.ts`** — l'événement `commands` est diffusé avec le bon
  `sessionId`.
- **`stream-reducer.test.ts`** — `commands` stocke la liste ; `null` avant tout
  événement ; `reset(history)` la remet à `null`.
- **`protocol.test.ts`** — `isServerEvent` accepte `'commands'` (le piège du
  `Set`).
- **`Composer.test.tsx`** — filtrage par préfixe sur `name` **et** sur `aliases` ;
  navigation `↑`/`↓` ; **`Enter` complète sans envoyer** ; **zéro résultat ⇒
  `Enter` envoie** ; complétion du **premier token seulement**, reste du
  brouillon préservé ; `⌘↵` envoie même popover ouvert ; `Esc` ferme en gardant
  le texte ; `src/foo` ne déclenche pas ; prop `commands` vide ⇒ pas de popover.

## Hors périmètre

- **Runner de scripts `package.json`** — spec séparée (sous-système
  indépendant). Décision de cadrage déjà prise pour elle : one-shot uniquement
  (`test`, `build`, `lint`), pas de serveur `dev` — les process persistants
  (orphelins, réattachement après reload) concentrent toute la complexité pour
  un usage mieux servi par un terminal.
- **Autocomplétion des arguments** — `argumentHint` est affiché, pas complété.
- **Palette de commandes en modale** — le composer suffit.
- **Création/édition de commandes depuis Atelier** — les fichiers `.md` sont
  gérés hors de l'app.
- **Support des ids de worktree** — suit le plan worktrees (§3).
