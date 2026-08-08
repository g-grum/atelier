# Sous-agents visibles dans le chat (design)

Date : 2026-08-08 · Statut : validé (cadrage + architecture approuvés par Germain)

## Objectif

Voir facilement ce que font les sous-agents d'une conversation, à la manière de l'arbre de progression de `/workflows` — mais **dans le fil du chat**, pas dans une vue séparée. Une ligne d'outil `Task` devient dépliable et contient la sous-conversation complète du sous-agent : ses outils, son texte, son thinking.

## État actuel (vérifié dans le code)

- Le texte des sous-agents est **jeté** : `sdk-client.ts:188` filtre `msg.parent_tool_use_id === null` avant d'émettre un `text_delta` (« only top-level text belongs in the chat »).
- Les `tool_use` / `tool_result` des sous-agents sont en revanche **déjà émis**, sans distinction de parent — ils s'affichent donc aujourd'hui **à plat**, mélangés aux outils du tour principal. L'imbrication corrige ce défaut existant en même temps.
- Une ligne `Task` est aujourd'hui **indiscernable** : `describeToolUse` n'a pas de cas `Task` et tombe sur le retour générique `{ kind: 'Other', summary: toolName }` (`describe-tool-use.ts:43`) — la ligne affiche littéralement « Task », et le protocole ne transporte pas le nom brut de l'outil.
- Le **thinking n'est rendu nulle part**, à aucun niveau (aucune occurrence dans `apps/` ni `packages/`).
- `ChatItem` (`stream-reducer.ts`) est une liste plate de `user | assistant | tool | permission | question`, sans parent ni profondeur.
- `ChatView` **n'est pas une boucle plate** : `toBlocks` (`ChatView.tsx:27`) replie les items en `Block[]`, où une ligne d'outil est poussée dans le `tools[]` du bloc `assistant` qui précède.

## Moyens SDK (vérifiés dans les typings 0.3.198)

| Besoin | Moyen |
|---|---|
| Texte + thinking des sous-agents en live | option `forwardSubagentText: true` — les blocs sont forwardés « **as assistant/user messages** with `parent_tool_use_id` set » |
| Rattachement live | `parent_tool_use_id`, présent sur `SDKAssistantMessage` (2733), `SDKUserMessage` (4253), `SDKPartialAssistantMessage` (3845) |
| Index des sous-agents d'une session | `listSubagents(sessionId, { dir })` → `string[]` d'`agentId` |
| Transcript d'un sous-agent | `getSubagentMessages(sessionId, agentId, { dir })` → `SessionMessage[]`, tableau vide si introuvable |
| Lien `agentId` → ligne `Task` | sidecar `<projectsRoot>/<encodeProjectDir(cwd)>/<sessionId>/subagents/agent-<agentId>.meta.json` → `{ agentType, description, toolUseId, spawnDepth }` |
| Thinking persisté | oui : blocs `{"type":"thinking"}` présents dans le transcript principal **et** dans ceux des sous-agents (vérifié sur disque) |

Précisions vérifiées, qui cadrent l'implémentation :

- Les enregistrements d'un transcript de sous-agent portent `agentId` / `isSidechain`, **pas** `parentToolUseId` : `getSubagentMessages` renvoie donc `parent_tool_use_id: null`. Le rattachement vient **uniquement** du sidecar — il n'y a pas de repli.
- Le **premier** enregistrement d'un transcript de sous-agent est un `type: 'user'` dont le contenu est le **prompt de mission complet**. Rendu tel quel, il produirait une grosse bulle « utilisateur » en tête du sous-arbre.
- Le sidecar `.meta.json` n'est **pas typé par le SDK** (seul le chemin des `.jsonl` est documenté, dans la docstring de `listSubagents`, avec le segment `<dir>`). Il est lu de façon défensive — voir « Gestion d'erreurs ».
- Les sous-agents de profondeur 2 vivent dans le **même** dossier plat `subagents/`, distingués par `spawnDepth`.

## Cadrage (décisions actées)

- **Emplacement** : inline dans le chat. La ligne `Task` se déplie sur place en sous-arbre indenté. Pas de widget, pas d'overlay.
- **Contenu du sous-arbre** : outils + texte + thinking du sous-agent.
- **Thinking** : rendu par la **même primitive** pour le tour principal et les sous-agents (pas d'asymétrie).
- **Pendant l'exécution** : sous-arbre **déplié automatiquement**, puis **replié** quand le sous-agent rend son résultat.
- **Après rechargement** : fidélité totale — le transcript du sous-agent est relu, texte et thinking compris.
- **Profondeur** : quelconque. Un sous-agent qui en lance un autre s'imbrique récursivement.

## Architecture

### Principe central : liste plate + `parentToolUseId`

Les items du chat **restent une liste plate ordonnée**. Chaque item porte l'identifiant de l'appel `Task` dont il descend ; l'arborescence est reconstruite au **rendu**, pas stockée.

L'alternative (`ChatItem.children[]`) a été écartée : `applyToolResult`, `applyDelta` et `closeTextRun` opèrent tous sur la liste plate et deviendraient récursifs — c'est le cœur du réducteur, très couvert par les tests, pour un bénéfice nul. Avec la liste plate, `applyToolResult` (un `map` par `toolUseId`) est inchangé, l'ordre chronologique est préservé gratuitement, et la profondeur N ne coûte rien.

### Protocole (`packages/shared/src/protocol.ts`)

- `tool_use` et `assistant_delta` gagnent `parentToolUseId?: string`. **Absent = tour principal** (jamais de chaîne vide, jamais de `null` — cohérent avec les autres champs optionnels du protocole).
- Nouvel événement `{ type: 'thinking_delta'; sessionId: string; text: string; parentToolUseId?: string }`, ajouté à `SERVER_EVENT_TYPES`.
- `ChatMessage` gagne la variante `{ role: 'thinking'; text: string; at: string }`, et **toutes** ses variantes gagnent `parentToolUseId?: string`.
- Nouveau type `SubagentRef = { agentId: string; toolUseId: string; agentType: string; description: string }`.
- `tool_result` reste inchangé : l'appariement par `toolUseId` suffit, le parent est porté par le `tool_use` correspondant.
- **Aucun drapeau « ceci est un Task »** n'est ajouté : côté client, une ligne d'outil est dépliable si et seulement si elle a des descendants dans `items` **ou** si un `SubagentRef` la désigne. Les deux informations sont déjà là.

### Identification d'une ligne `Task`

`describeToolUse` gagne un cas `Task`, sur le modèle du cas `AskUserQuestion` existant : le résumé est construit depuis l'input de l'outil (`description` et `subagent_type`) — par exemple « Sous-agent general-purpose : Re-review spec autopilot » — au lieu du littéral « Task ». Comme `mapSessionMessages` passe par la même fonction, le live et l'historique affichent la même chose. C'est le cœur de l'objectif : la ligne dit *quoi*, le dépliement dit *comment*.

### Serveur — live

- `buildQueryOptions` : ajout de `forwardSubagentText: true`.
- `SdkTurnEvent` (`sdk-client.ts:22`) gagne `parentToolUseId?` sur `text_delta` et `tool_use`, plus une variante `thinking_delta`. `handleTurnEvent` (`session-stream.ts:211`) est l'endroit où le `ServerEvent` est construit et diffusé : il propage les nouveaux champs et relaie `thinking_delta`.
- Mapping des messages SDK, **frontière assumée par défaut** :
  - **tour principal** : les deltas restent la source unique de texte (règle existante, inchangée) ; les `stream_event` de type `thinking_delta` avec `parent_tool_use_id === null` deviennent des événements `thinking_delta`.
  - **sous-agents** : le texte et le thinking sont extraits des **blocs des messages `assistant`** dont `parent_tool_use_id !== null` — c'est ce que documente `forwardSubagentText`. Les deltas partiels de sous-agent, s'il en arrive, sont **ignorés** : mélanger les deux sources doublerait le texte, exactement le piège documenté en tête du mapping actuel.
  - Conséquence UX assumée : le texte d'un sous-agent apparaît par blocs à la complétion de chaque message, alors que ses outils défilent en direct. Le thinking d'un sous-agent est émis comme un `thinking_delta` unique portant tout son contenu — le réducteur n'y voit qu'un run de plus.
- `partialText` (snapshot envoyé à chaque connexion en cours de tour) continue de n'accumuler **que** le tour principal : c'est un instantané du run de premier niveau, un texte de sous-agent y serait mal replacé.

**Sonde préalable obligatoire.** La frontière ci-dessus est déduite de la docstring, pas observée. Avant d'écrire le mapping, une sonde contre le **vrai SDK** (serveur isolé `--port`/`--token`/`--data` + client WS, comme pour le QCM et l'autopilot) établit, avec et sans `forwardSubagentText` : quels messages portent le texte d'un sous-agent (deltas, blocs finaux, ou les deux), si son thinking suit le même chemin, et — pour un sous-agent qui en lance un autre — que `parent_tool_use_id` désigne bien le `Task` **le plus proche** et que le `tool_use` intermédiaire porte lui-même son parent. Tout le design récursif repose sur ce dernier point. Si la sonde contredit la frontière, c'est la sonde qui gagne, et la règle « une seule source de texte par niveau » est maintenue.

### Serveur — historique, en deux temps

Mesure sur deux sessions réelles : 3,4 Mo de transcript principal contre 3,3 Mo de sous-agents (26 sous-agents), et 1,65 Mo contre 2,25 Mo (13 sous-agents). Tout charger à l'ouverture **doublerait** le coût de parsing d'une session. L'historique est donc paresseux.

Le `SdkClient` reste le seul point de contact avec le SDK (c'est le seam qui rend le serveur testable via `sdk-client.mock.ts`). Deux méthodes s'ajoutent à l'interface :

- `listSubagentRefs(sessionId: string, cwd: string): Promise<SubagentRef[]>` — `listSubagents()` puis lecture des **seuls** sidecars (~150 octets chacun), via `encodeProjectDir(cwd)` (déjà exporté, `sdk-client.ts:476`).
- `getSubagentMessages(sessionId: string, agentId: string, cwd: string): Promise<ChatMessage[]>` — `getSubagentMessages()` du SDK, mappé par **le même `mapSessionMessages`** que l'historique principal, puis estampillé avec le `parentToolUseId` du sidecar.

Le parsing défensif du sidecar et l'élagage du prompt de mission vivent dans un module pur `apps/server/src/sessions/subagent-history.ts` (testable sans SDK ni disque). Élagage : le **premier** enregistrement `user` du transcript est le prompt de mission — il est écarté, la ligne `Task` le résume déjà.

`SessionsService` expose les deux méthodes en résolvant ce que les routes n'ont pas : le `cwd` du projet et, pour un draft, `resolveSessionId`. Deux routes minces :

- `GET /api/sessions/:id/subagents` → `SubagentRef[]`
- `GET /api/sessions/:id/subagents/:agentId` → `ChatMessage[]`

Comme `GET /api/sessions/:id/messages` aujourd'hui, elles renvoient **`[]`** pour un draft, une session inconnue ou un `agentId` inconnu — jamais 404. `SessionsService.messages(id)` reste inchangé : aucune régression de performance à l'ouverture.

La profondeur N tombe d'elle-même : les lignes `Task` *contenues dans* un sous-agent portent leur propre chevron, et leur dépliement déclenche le même `GET` pour l'`agentId` correspondant. Aucune récursion serveur, aucune notion de `spawnDepth` dans le code.

`mapSessionMessages` gagne l'extraction des blocs `thinking` → `{ role: 'thinking' }`, et propage `parent_tool_use_id`.

### Web — réducteur

- `ChatItem` : `parentToolUseId?: string` sur toutes les variantes ; nouvelle variante `{ kind: 'thinking'; text: string; streaming: boolean }`.
- `applyDelta` ne fusionne un delta avec le dernier run de texte **que si le parent est identique** — sinon le texte d'un sous-agent se collerait à la réponse du tour principal. Même règle pour `applyThinkingDelta`.
- `closeTextRun` ferme les runs `assistant` **et** `thinking`, à tous les niveaux.
- `applyStatus` : le snapshot `partialText` cible désormais le dernier run `assistant` streaming **sans parent**. Sans ce garde, un texte de sous-agent en cours serait écrasé par le snapshot du tour principal à chaque reconnexion.
- `reset(history)` : nouveau cas `thinking` et propagation de `parentToolUseId`. Le `switch` sur `message.role` n'a pas de `default` — sans ce cas, le thinking du tour principal serait silencieusement perdu au rechargement, ce qui contredirait « fidélité totale ». La conversion `ChatMessage → ChatItem` est extraite dans un helper partagé, utilisé par `reset` **et** par l'injection ci-dessous.
- Nouvelle action d'injection : insère les `ChatMessage[]` d'un sous-agent **juste après** sa ligne `Task`, dans l'ordre, et enregistre l'`agentId` comme chargé. `reset()` repart d'un ensemble vide (l'historique injecté ne survit pas à un resync — voir la règle de fetch déclarative).
- `applyToolResult`, `applyPermissionRequest`, `applyQuestionRequest`, `trackModifiedFile` : inchangés. Les fichiers modifiés par un sous-agent alimentent le même compteur — c'est le comportement voulu.

### Web — rendu

`toBlocks` devient **récursif**, ce qui préserve intégralement la sémantique de bloc existante à l'intérieur de chaque sous-arbre :

1. Une passe de partition sépare les items par `parentToolUseId` : les items sans parent (ou dont le `Task` parent est absent de la liste — voir « orphelin ») forment le niveau courant, les autres sont regroupés par `toolUseId` de parent.
2. Une ligne d'outil qui a un groupe d'enfants **ou** un `SubagentRef` produit un bloc `{ type: 'subagent'; task: ToolChatItem; blocks: Block[] }`, ses enfants étant passés au même `toBlocks`. Les autres lignes d'outil continuent d'aller dans le `tools[]` du bloc `assistant` qui précède, comme aujourd'hui.

L'indentation vient donc de l'imbrication du rendu, pas d'un calcul de profondeur. Sans cette récursion, le premier texte d'un sous-agent ouvrirait un bloc `assistant` frère et couperait le sous-arbre en deux.

- Repli : un `Set<toolUseId>` de `Task` repliés, plus un `Set` de `Task` **basculés à la main**. Le repli automatique de fin de sous-agent (déclenché à l'arrivée du `result` du `Task`) ignore ces derniers — un dépliement explicite ne doit jamais se refermer sous les yeux de l'utilisateur.
- Un `Task` replié masque ses descendants et affiche un compteur d'enfants. **Invariant** : les items `permission` et `question` sont rendus à la racine (voir « Gestion d'erreurs »), donc un repli ne peut jamais cacher une demande en attente.
- Rail vertical gauche pour matérialiser la sous-conversation, en teinte `muted` — **ni ambre (réservé aux permissions) ni indigo (réservé au QCM)**.
- Nouveau `ThinkingBlock` : replié par défaut (« Réflexion » + chevron), corps rendu par `MarkdownBody` (déjà paresseux). Utilisé **aux deux niveaux** — c'est du même coup le premier rendu du thinking du tour principal dans Atelier.
- `showTyping` (`ChatView.tsx:83`) s'appuie sur `items.at(-1)` : un run `thinking` streaming en dernière position compte comme « du texte arrive », l'indicateur de frappe est donc supprimé dans ce cas, au même titre qu'un run `assistant` streaming.

### Web — chargement paresseux

`Backend` (`api/backend.ts`) gagne `listSubagents(sessionId)` et `getSubagentMessages(sessionId, agentId)`, avec leurs implémentations de fixtures (`VITE_USE_FIXTURES`) — sans quoi le mode démo casse.

`SessionController` porte le chargement : il possède déjà l'état, `reset` et le fetch de l'historique. La règle est **déclarative**, pas événementielle :

> pour tout `Task` déplié qui n'a aucun descendant dans `items` et dont un `SubagentRef` existe, charger son transcript une fois.

Cette formulation unique couvre les trois cas et évite le doublon que produirait un « fetch au clic » : un sous-agent vu en live a déjà ses descendants → aucun fetch ; un `Task` déplié après rechargement n'en a pas → fetch ; un resync qui vide l'historique injecté laisse un `Task` déplié sans descendants → rechargement automatique.

L'index `SubagentRef[]` est chargé à l'ouverture de la session et après un resync. Il n'est pas rafraîchi en cours de tour : un sous-agent qui démarre pendant le tour fournit ses descendants en direct, l'index ne lui sert à rien.

## Gestion d'erreurs

- **Sidecar absent, illisible ou sans `toolUseId`** : le sous-agent n'est pas indexé, sa ligne `Task` n'a pas de chevron (sauf descendants live). On perd le détail, on n'invente **jamais** un rattachement — une imbrication fausse est pire qu'une absente.
- **`getSubagentMessages` vide ou en échec** : le dépliement affiche une indisponibilité dans le sous-arbre et la tentative n'est pas répétée en boucle ; la ligne `Task` reste utilisable.
- **`parentToolUseId` orphelin** (parent absent de `items`, ex. historique tronqué) : l'item est rendu au niveau courant, à sa place chronologique. Jamais masqué, jamais perdu.
- **Permission ou QCM levé *dans* un sous-agent** : l'item est rendu **à la racine**, pas dans le sous-arbre. Une demande en attente bloque le tour ; la cacher derrière un `Task` replié le figerait derrière une invite invisible. Le sous-arbre est donc visuellement interrompu par l'invite pendant l'exécution — coupure assumée, et le mode de permission par défaut fait que c'est le cas courant, pas un cas limite. (`CanUseTool` expose `agentID` : un rattachement propre est possible plus tard, cf. « Hors périmètre ».)
- **Sous-agent en cours à la reconnexion** : les deltas suivants portent leur `parentToolUseId` et se rattachent dès que le `tool_use` du `Task` est connu ; sinon la règle « orphelin » s'applique. L'historique injecté perdu au `reset` est rechargé par la règle déclarative.
- **Volume** : un `Task` de plusieurs dizaines d'outils déplié en direct fait défiler beaucoup ; c'est précisément pourquoi il se replie à la fin. Aucun préchargement des transcripts non dépliés.

## Tests

- **Réducteur** : imbrication d'un `tool_use` enfant ; non-fusion de deux runs de texte de parents différents ; runs de thinking (principal et enfant) ; `reset` restitue le thinking et les parents ; injection (position, `agentId` marqué chargé) ; `partialText` n'écrase pas un run de sous-agent ; item orphelin rendu au niveau courant.
- **`toBlocks`** : un `Task` avec enfants produit un bloc `subagent` ; le texte d'un sous-agent reste **dans** ce bloc ; les lignes d'outil sans enfants gardent le comportement actuel ; profondeur 2 ; orphelin au niveau courant.
- **`ChatView`** : un `Task` replié masque ses descendants ; repli automatique à l'arrivée du `result` ; un `Task` déplié à la main **ne** se replie pas ; une `permission` d'un sous-agent reste visible sous un `Task` replié ; `showTyping` avec un run `thinking` en dernière position.
- **`ThinkingBlock`** : replié par défaut, bascule, rendu markdown.
- **Chargement paresseux** : pas de fetch quand les descendants sont déjà là (le doublon live/historique) ; fetch au dépliement après rechargement ; rechargement après resync ; échec → pas de boucle.
- **Serveur** : `describeToolUse` sur un input `Task` ; passe-plat de `parentToolUseId` (deltas et `tool_use`) ; émission d'un `thinking_delta` ; extraction des blocs `thinking` par `mapSessionMessages` ; `subagent-history` (sidecar manquant, sidecar malformé, élagage du prompt de mission) ; les deux routes sur un draft et un `agentId` inconnu → `[]`.
- **Vérification réelle** : la sonde SDK en amont (source de texte unique, profondeur 2) et, en fin de parcours, un tour réel avec sous-agent observé de bout en bout — live, repli automatique, rechargement, dépliement — comme pour le QCM et l'autopilot.

## Hors périmètre

- Vue agrégée type `/workflows` (arbre global, phases, compteurs de tokens par agent).
- Métriques par sous-agent (durée, tokens) : le sidecar ne les porte pas.
- Rattachement des permissions et QCM au sous-arbre de leur sous-agent via `CanUseTool.agentID`.
- Interaction avec un sous-agent en cours (interruption ciblée, redirection).
- Recherche dans les transcripts de sous-agents.

## Notes de contexte

- `apps/server/src/sdk/sdk-client.ts` porte une modification non commitée (nettoyage du transcript de la sonde `listCommands`) dans le fichier même que cette feature touche : à committer ou jeter avant de démarrer.
- Un worktree `.worktrees/review-merge` (branche `feat-review-merge`) est actif en parallèle.
- Si le plan devient trop gros, la ligne de découpe naturelle est le **thinking** (événement de protocole + extraction dans `mapSessionMessages` + `ThinkingBlock`, tour principal inclus) : c'est une feature livrable indépendamment, embarquée ici pour la symétrie voulue.
