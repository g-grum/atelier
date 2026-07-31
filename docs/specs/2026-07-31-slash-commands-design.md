# Slash commands dans le composer — design

Date: 2026-07-31 · Statut: validé avec le propriétaire (Germain) en brainstorming.

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
2. **Deux sources, une règle de remplacement.** Scan disque via REST à
   l'ouverture de session (disponible avant tout tour) ; `supportedCommands()`
   du SDK pendant le tour (fait autorité, **remplace** la liste).
3. **Pas de validation des commandes inconnues.** `/nope` part tel quel : le
   CLI connaît des commandes que notre liste peut ignorer, les rejeter
   créerait des faux négatifs.
4. **Tout dégrade en silence.** L'autocomplétion est un confort ; aucun de ses
   échecs ne doit gêner l'envoi d'un message ni afficher de bannière d'erreur.
5. **Liste clefée par projet, pas par session.** Les commandes dépendent du
   `cwd`.

### Approches écartées

- **A — SDK seul, paresseux.** N'appeler que `supportedCommands()` pendant le
  tour. Rejeté : sur une session neuve, aucune commande avant le premier tour,
  or c'est précisément là qu'on veut taper `/review`.
- **B — Scan disque seul.** Rejeté comme solution finale : rate les commandes
  natives (`/compact`, `/usage`) et celles des plugins/skills.
- **D — `query()` jetable à l'ouverture de session** pour lire la liste faisant
  autorité sans parser le disque. Séduisant mais risque d'effet de bord (session
  fantôme dans le transcript). Conservé comme **spike** (§ Spikes) : s'il est
  propre, il remplace le scan disque et supprime le parser.

## Constat SDK (vérifié dans `sdk.d.ts` 0.3.198)

- `SlashCommand = { name, description, argumentHint, aliases, … }`
  (`sdk.d.ts:6242`) — `name` est **sans** le slash initial.
- `supportedCommands(): Promise<SlashCommand[]>` (`sdk.d.ts:2323`) est une
  méthode de l'objet `Query`, donc **disponible seulement pendant un tour**.
  C'est toute la raison d'être de la double source.
- `SDKCommandsChangedMessage` (`sdk.d.ts:2780-2785`) : `type: 'system'`,
  `subtype: 'commands_changed'`, `commands`. La doc du SDK est explicite — les
  clients doivent **REMPLACER** leur liste en cache, car `supportedCommands()`
  est capturé une fois à l'`initialize` et ne reflète jamais les changements en
  cours de session. D'où la règle de remplacement (décision 2), et non un merge.
- **`settingSources` omis = toutes les sources chargées** (`sdk.d.ts:1836-1846`,
  « Must include `'project'` to load CLAUDE.md files »).
  `buildQueryOptions` (`sdk-client.ts:243-259`) ne le passe pas : les
  `.claude/commands/` du projet sont **déjà** chargées. **Aucun changement requis**
  — et il faut veiller à ne pas introduire de `settingSources` restrictif, qui
  les désactiverait silencieusement.

## Architecture

### 1. Contrat partagé — `packages/shared/src/protocol.ts`

`protocol.ts` est aujourd'hui totalement dépendance-free ; on définit **notre
propre type** plutôt que d'importer celui du SDK, pour ne pas y faire entrer le
SDK.

```ts
/** Une slash command proposée à l'autocomplétion. `name` est sans le slash initial (contrat SDK). */
export type SlashCommandInfo = { name: string; description: string; argumentHint: string }
```

Nouvelle variante de `ServerEvent` (`protocol.ts:110-117`) :

```ts
| { type: 'commands'; sessionId: string; commands: SlashCommandInfo[] }
```

**Piège à ne pas manquer :** ajouter `'commands'` au `Set` `SERVER_EVENT_TYPES`
(`protocol.ts:119`). `isServerEvent` filtre sur ce `Set` explicite — un type
ajouté sans son entrée serait silencieusement jeté côté client, sans erreur.

`ClientMessage` est **inchangé** : une slash command part comme un
`user_message` normal (décision 1).

### 2. Serveur — `apps/server/src/commands/discover-commands.ts`

Scan de `<cwd>/.claude/commands/**/*.md` puis `~/.claude/commands/**/*.md`,
parse du frontmatter (`description`, `argument-hint`).

- **Couture fs injectable**, sur le modèle de `GhRun` (`gh-runner.ts:2`) : la
  fonction prend un lecteur de répertoire/fichier en paramètre pour que les
  tests n'aient pas besoin du disque.
- **Contrat ne-jette-jamais**, sur le modèle de `deriveMessageCount`
  (`sdk-client.ts:387-397`) : dossier absent, fichier illisible, frontmatter
  malformé → l'entrée est ignorée, on renvoie une liste partielle. Jamais
  d'exception, jamais de rejet.
- **Précédence projet > user** sur collision de nom.
- `description` absente → chaîne vide ; `argumentHint` absent → chaîne vide.
  Jamais `undefined`, pour que le type reste total côté web.

### 3. Serveur — `apps/server/src/commands/commands-routes.ts`

`GET /api/projects/:id/commands` → `SlashCommandInfo[]`.

Monté auprès des autres routes (`app.ts:37-39`). Résolution de l'id d'espace de
travail vers un chemin : réutilise le résolveur existant utilisé par les autres
routes de projet, donc un id de worktree fonctionne sans travail supplémentaire.
Projet inconnu → 404, cohérent avec `sessions-routes.ts`.

### 4. Serveur — `apps/server/src/sdk/sdk-client.ts`

Un `SdkTurnEvent` de plus (`sdk-client.ts:21-29`) :

```ts
| { type: 'commands'; commands: SlashCommandInfo[] }
```

Deux points d'émission dans `runTurn` :

- **À l'init du tour**, juste à côté de la sonde `usage` existante
  (`sdk-client.ts:104-121`) : `await q.supportedCommands()`, mappé puis yieldé.
  Même politique que la sonde `usage` — enveloppé dans un `try {} catch {}`
  muet, « ne jamais laisser une sonde casser le tour ».
- **Sur `system` / `subtype === 'commands_changed'`** dans la boucle de
  messages : mappé puis yieldé, puis `continue` (le bloc `system`/`init`
  existant est un précédent direct de ce motif).

Le mapping `SlashCommand → SlashCommandInfo` est une fonction pure exportée,
couture testable pour un contrat de frontière que le mock ne voit pas — même
justification que `mapUsageWindows` et `buildQueryOptions`.

`sdk-client.mock.ts` gagne la capacité d'émettre l'événement.

### 5. Serveur — `apps/server/src/stream/session-stream.ts`

`handleTurnEvent` (`session-stream.ts:177`) relaie l'événement en `ServerEvent`
`commands` avec le `sessionId`, via le `broadcast` existant. Rien d'autre à
changer : pas d'état de tour, pas d'interaction avec l'invariant
un-tour-par-session ni avec la logique owner-only de `runTurn`.

### 6. Web — état

- Le REST passe par React Query (déjà utilisé), clefé par projet.
- Le `stream-reducer` stocke `commands: SlashCommandInfo[] | null`
  (`null` = jamais reçu) sur l'événement WS.
- Le composer lit **`wsCommands ?? restCommands`** : précédence, pas de fusion.
  La liste SDK gagne intégralement dès qu'elle arrive — c'est exactement le
  contrat « remplace ta liste » du SDK, et ça évite de réconcilier deux sources
  divergentes.

### 7. Web — autocomplétion (`components/Composer.tsx`)

**Déclenchement volontairement strict :** le popover n'apparaît que si le
brouillon **commence** par `/` (position 0) et que le curseur est encore dans le
premier mot. Sinon `src/foo` ou une URL déclencherait l'autocomplétion en pleine
phrase.

Filtrage par préfixe sur `name`. Affichage : `nom`, `description`,
`argumentHint` (affiché, pas complété).

Clavier — le conflit central est que `Enter` envoie aujourd'hui le message
(`Composer.tsx:60-66`) ; popover ouvert il doit **compléter**, sinon on envoie
`/rev` au lieu de choisir `/review` :

| Touche | Popover ouvert | Popover fermé |
|---|---|---|
| `↑` `↓` | navigue dans la liste | comportement actuel |
| `Enter` / `Tab` | complète en `/nom ` | envoie |
| `Esc` | ferme, garde le texte | — |
| `⌘↵` | **envoie toujours** | envoie |

`⌘↵` conserve son échappatoire inconditionnelle. Sélection à la souris
également. Accessibilité : `role="listbox"` / `role="option"` +
`aria-activedescendant`, cohérent avec les composants Radix en place.

## Flux

1. Ouverture de session → `GET /api/projects/:id/commands` → liste disque
   affichable immédiatement.
2. L'utilisateur tape `/` → popover, filtré à la frappe.
3. `Enter` → le texte devient `/review `, le popover se ferme.
4. `Enter` (popover fermé) ou `⌘↵` → `user_message` `/review` → `runTurn` passe
   le prompt inchangé au SDK → le CLI expanse la commande.
5. Au premier tour, la sonde `supportedCommands()` émet `commands` → le
   reducer **remplace** la liste par celle du SDK (natives et plugins inclus).
6. Découverte dynamique en cours de session → `commands_changed` → nouveau
   `commands` → remplacement.

## Gestion d'erreurs

| Cas | Comportement |
|---|---|
| REST en échec | Pas d'autocomplétion. **Aucune bannière.** Le composer reste pleinement utilisable — `/review` peut être tapé à la main. |
| Liste vide | Pas de popover. |
| `supportedCommands()` en échec | Sonde muette ; on garde la liste disque. Le tour continue normalement. |
| `.claude/commands/` absent | Liste partielle (user seul) ou vide. Pas une erreur. |
| Fichier illisible / frontmatter malformé | Entrée ignorée, le reste de la liste est renvoyé. |
| Commande inconnue envoyée | Transmise telle quelle ; c'est le CLI qui répond (décision 3). |
| Changement de projet | Refetch ; la liste est clefée par projet. |

## Spikes (avant d'écrire le parser)

1. **Namespacing et frontmatter** (~10 min) : vérifier la convention réelle des
   sous-dossiers (`.claude/commands/git/pr.md` → `/git:pr` ?) et les clés de
   frontmatter effectivement lues, plutôt que de les supposer.
2. **Approche D** (~15 min) : un `query()` jetable à l'ouverture de session
   crée-t-il une session fantôme dans le transcript ? Si non, il remplace le
   scan disque et **supprime** `discover-commands.ts` et son parser. Si oui, on
   reste sur l'architecture ci-dessus.

Le résultat du spike 2 peut donc retirer les sections 2 et 3 de
l'architecture ; le reste (protocole, sonde SDK, stream, web) est inchangé dans
les deux cas.

## Tests

- **`discover-commands.test.ts`** — frontmatter présent/absent/malformé ;
  sous-dossiers ; dossier absent ; fichier illisible ; précédence projet > user.
- **`sdk-client.test.ts`** — mapping `SlashCommand → SlashCommandInfo` ;
  émission sur `commands_changed` ; échec de la sonde n'interrompt pas le tour.
- **`session-stream.test.ts`** — l'événement `commands` est diffusé avec le bon
  `sessionId`.
- **`protocol.test.ts`** — `isServerEvent` accepte `'commands'` (le piège du
  `Set`).
- **`Composer.test.tsx`** — filtrage par préfixe ; navigation `↑`/`↓` ;
  **`Enter` complète sans envoyer** ; `⌘↵` envoie même popover ouvert ; `Esc`
  ferme en gardant le texte ; `src/foo` ne déclenche pas ; liste vide → pas de
  popover ; précédence `wsCommands ?? restCommands`.
- **`commands-routes.test.ts`** — 200 avec liste ; 404 projet inconnu.

## Hors périmètre

- **Runner de scripts `package.json`** — spec séparée (sous-système
  indépendant). Décision de cadrage déjà prise pour elle : one-shot
  uniquement (`test`, `build`, `lint`), pas de serveur `dev` — les process
  persistants (orphelins, réattachement après reload) concentrent toute la
  complexité pour un usage mieux servi par un terminal.
- **Alias de commandes** (`/cost` → `/usage`) — le SDK les expose, v2.
- **Autocomplétion des arguments** — `argumentHint` est affiché, pas complété.
- **Palette de commandes en modale** — le composer suffit.
- **Création/édition de commandes depuis Atelier** — les fichiers `.md` sont
  gérés hors de l'app.
