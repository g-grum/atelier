# Sous-agents visibles dans le chat (design)

Date : 2026-08-08 · Statut : validé (cadrage + architecture approuvés par Germain)

## Objectif

Voir facilement ce que font les sous-agents d'une conversation, à la manière de l'arbre de progression de `/workflows` — mais **dans le fil du chat**, pas dans une vue séparée. Une ligne d'outil `Task` devient dépliable et contient la sous-conversation complète du sous-agent : ses outils, son texte, son thinking.

## État actuel (vérifié dans le code)

- Le texte des sous-agents est **jeté** : `apps/server/src/sdk/sdk-client.ts` filtre `msg.parent_tool_use_id === null` avant d'émettre un `text_delta` (commentaire en place : « only top-level text belongs in the chat »).
- Les `tool_use` / `tool_result` des sous-agents sont en revanche **déjà émis**, sans distinction de parent — donc ils s'affichent aujourd'hui **à plat**, mélangés aux outils du tour principal. L'imbrication corrige ce défaut existant en même temps.
- Le **thinking n'est rendu nulle part** dans Atelier, à aucun niveau (aucune occurrence dans `apps/` ni `packages/`).
- `ChatItem` (`apps/web/src/state/stream-reducer.ts`) est une liste plate de `user | assistant | tool | permission | question`, sans notion de parent ni de profondeur.

## Moyens SDK (vérifiés dans les typings 0.3.198)

| Besoin | Moyen |
|---|---|
| Texte + thinking des sous-agents en live | option `forwardSubagentText: true` (« the full subagent conversation is forwarded so consumers can render a nested transcript ») |
| Rattachement live | `parent_tool_use_id`, déjà présent sur `SDKAssistantMessage`, `SDKUserMessage` et `SDKPartialAssistantMessage` |
| Index des sous-agents d'une session | `listSubagents(sessionId, { dir })` → `string[]` d'`agentId` |
| Transcript d'un sous-agent | `getSubagentMessages(sessionId, agentId, { dir })` → `SessionMessage[]` (même forme que `getSessionMessages`, `parent_tool_use_id` inclus) |
| Lien `agentId` → ligne `Task` | sidecar `~/.claude/projects/<projectKey>/<sessionId>/subagents/agent-<agentId>.meta.json` → `{ agentType, description, toolUseId, spawnDepth }` |
| Thinking persisté | oui : blocs `{"type":"thinking"}` présents dans le transcript principal **et** dans ceux des sous-agents (vérifié sur disque) |

Le chemin des transcripts de sous-agents est documenté dans la docstring de `listSubagents`. Le sidecar `.meta.json`, lui, **n'est pas typé par le SDK** — il est lu de façon défensive (voir « Gestion d'erreurs »).

## Cadrage (décisions actées)

- **Emplacement** : inline dans le chat. La ligne `Task` se déplie sur place en sous-arbre indenté. Pas de widget, pas d'overlay.
- **Contenu du sous-arbre** : outils + texte + thinking du sous-agent.
- **Thinking** : rendu par la **même primitive** pour le tour principal et les sous-agents (pas d'asymétrie).
- **Pendant l'exécution** : le sous-arbre est **déplié automatiquement**, puis **replié** quand le sous-agent rend son résultat.
- **Après rechargement** : fidélité totale — le transcript du sous-agent est relu, texte et thinking compris.
- **Profondeur** : quelconque. Un sous-agent qui en lance un autre (`spawnDepth ≥ 2`) s'imbrique récursivement.

## Architecture

### Principe central : liste plate + `parentToolUseId`

Les items du chat **restent une liste plate ordonnée**. Chaque item porte l'identifiant de l'appel `Task` dont il descend ; l'arborescence est une décision de *rendu*, pas de structure.

L'alternative (`ChatItem.children[]`) a été écartée : `applyToolResult`, `applyDelta` et `closeTextRun` opèrent tous sur la liste plate et deviendraient récursifs — c'est le cœur du réducteur, très couvert par les tests, pour un bénéfice nul. Avec la liste plate, `applyToolResult` (un `map` par `toolUseId`) est inchangé, l'ordre chronologique est préservé gratuitement, et la profondeur N ne coûte rien.

### Protocole (`packages/shared/src/protocol.ts`)

- `tool_use` et `assistant_delta` gagnent `parentToolUseId?: string`. **Absent = tour principal** (jamais de chaîne vide, jamais de `null` — cohérent avec les autres champs optionnels du protocole).
- Nouvel événement `{ type: 'thinking_delta'; sessionId: string; text: string; parentToolUseId?: string }`, ajouté à `SERVER_EVENT_TYPES`.
- `ChatMessage` gagne la variante `{ role: 'thinking'; text: string; at: string }`, et **toutes** ses variantes gagnent `parentToolUseId?: string`.
- Nouveau type `SubagentRef = { agentId: string; toolUseId: string; agentType: string; description: string }`.
- `tool_result` reste inchangé : l'appariement par `toolUseId` suffit, le parent est déjà porté par le `tool_use` correspondant.

### Serveur — live

- `buildQueryOptions` : ajout de `forwardSubagentText: true`.
- Mapping dans `runTurn` (`sdk-client.ts`) : le filtre `parent_tool_use_id === null` disparaît ; la valeur est propagée en `parentToolUseId` (`?? undefined`) sur les `text_delta` et les `tool_use`. Les deltas de type `thinking_delta` des `stream_event` deviennent des événements `thinking_delta`.
- `partialText` (snapshot envoyé à chaque connexion en cours de tour) continue de n'accumuler **que** le tour principal : c'est un instantané du run de texte de premier niveau, un texte de sous-agent y serait mal replacé.

**Sonde préalable obligatoire.** Le mapping actuel documente un piège : avec `includePartialMessages`, extraire les blocs de texte des messages `assistant` finaux **doublerait** chaque réponse, les deltas étant la source unique. Le même risque existe pour les sous-agents, et `forwardSubagentText` peut déplacer la frontière (deltas partiels des sous-agents déjà émis ? blocs finaux en plus ?). Avant d'écrire ce mapping, une sonde contre le **vrai SDK** (serveur isolé `--port`/`--token`/`--data` + client WS, comme pour le QCM et l'autopilot) établit ce qui arrive réellement, avec et sans l'option, et donc quelle est la source de texte unique. La règle « les deltas sont la seule source de texte » est maintenue par défaut, à tous les niveaux.

### Serveur — historique, en deux temps

Mesure sur une session réelle de 26 sous-agents : transcript principal 3,4 Mo, transcripts de sous-agents 3,3 Mo cumulés. Tout charger à l'ouverture **doublerait** le coût de parsing d'une session. L'historique est donc paresseux, dans un nouveau module `apps/server/src/sessions/subagent-history.ts` :

1. `GET /api/sessions/:id/subagents` → `SubagentRef[]`. Appelle `listSubagents()` puis lit **uniquement** les sidecars `.meta.json` (~150 octets chacun). C'est assez pour que chaque ligne `Task` sache qu'elle a un transcript et affiche son chevron.
2. `GET /api/sessions/:id/subagents/:agentId` → `ChatMessage[]`. Appelle `getSubagentMessages()`, réutilise **le même `mapSessionMessages`** que l'historique principal, et estampille chaque message avec le `parentToolUseId` du sidecar. Appelé au premier dépliement d'un `Task`.

`SessionsService.messages(id)` reste inchangé — pas de régression de performance à l'ouverture.

La profondeur N tombe d'elle-même : les lignes `Task` *contenues dans* un sous-agent portent leur propre chevron, et leur dépliement déclenche le même `GET` pour l'`agentId` correspondant. Aucune récursion serveur, aucune notion de `spawnDepth` dans le code.

`mapSessionMessages` gagne l'extraction des blocs `thinking` → `{ role: 'thinking' }`, et propage `parent_tool_use_id`.

### Web — réducteur

- `ChatItem` : `parentToolUseId?: string` sur toutes les variantes ; nouvelle variante `{ kind: 'thinking'; text: string; streaming: boolean }`.
- `applyDelta` ne fusionne un delta avec le dernier run de texte **que si le parent est identique** — sinon le texte d'un sous-agent se collerait à la réponse du tour principal. Même règle pour un nouveau `applyThinkingDelta`.
- `closeTextRun` ferme les runs `assistant` **et** `thinking`, à tous les niveaux.
- `applyToolResult`, `applyPermissionRequest`, `applyQuestionRequest`, `trackModifiedFile` : inchangés. Les fichiers modifiés par un sous-agent alimentent le même compteur — c'est le comportement voulu.
- Nouvelle action d'injection d'historique de sous-agent : insère les `ChatMessage[]` reçus **juste après** la ligne `Task` correspondante, en préservant leur ordre. Idempotente (une deuxième injection du même `agentId` ne duplique rien).

### Web — rendu

- `ChatView` calcule la profondeur de chaque item en remontant la chaîne `parentToolUseId` via un index `toolUseId → item`, et l'indente par une variable CSS.
- Repli : un `Set<toolUseId>` de `Task` repliés, plus un `Set` de `Task` **basculés à la main**. Le repli automatique de fin de sous-agent (déclenché à l'arrivée du `result` du `Task`) ignore ces derniers — un dépliement explicite de l'utilisateur ne doit jamais se refermer sous ses yeux.
- Un `Task` replié masque tous ses descendants et affiche un compteur d'enfants.
- `ToolCallItem` : la ligne `Task` gagne le chevron d'imbrication. Rail vertical gauche pour matérialiser la sous-conversation, en teinte `muted` — **ni ambre (réservé aux permissions) ni indigo (réservé au QCM)**.
- Nouveau `ThinkingBlock` : replié par défaut (« Réflexion » + chevron), corps rendu par `MarkdownBody` (déjà paresseux). Utilisé **aux deux niveaux** — c'est du même coup le premier rendu du thinking du tour principal dans Atelier.

## Gestion d'erreurs

- **Sidecar `.meta.json` absent, illisible ou sans `toolUseId`** : le sous-agent n'est pas indexé, sa ligne `Task` n'a pas de chevron. On perd le détail, on n'invente **jamais** un rattachement — une imbrication fausse est pire qu'une absente.
- **`getSubagentMessages` vide ou en échec** : le dépliement affiche un message d'indisponibilité dans le sous-arbre, la ligne `Task` reste utilisable. Le contrat SDK est « tableau vide si introuvable », donc l'absence n'est pas une exception.
- **`parentToolUseId` orphelin** (parent inconnu du réducteur, ex. resync partiel) : l'item est rendu à la racine, profondeur 0. Jamais masqué, jamais perdu.
- **Sous-agent encore en cours à la reconnexion** : rien de spécial — les deltas suivants portent leur `parentToolUseId` et se rattachent dès que le `tool_use` du `Task` est connu ; sinon la règle « orphelin → racine » s'applique.
- **Volume** : un `Task` de plusieurs dizaines d'outils déplié en direct fait défiler beaucoup ; c'est précisément pourquoi il se replie à la fin. Aucun préchargement des transcripts non dépliés.

## Tests

- **Réducteur** : imbrication d'un `tool_use` enfant ; non-fusion de deux runs de texte de parents différents ; runs de thinking (principal et enfant) ; injection d'historique de sous-agent (position et idempotence) ; item orphelin rendu à la racine.
- **`ChatView`** : indentation par profondeur ; un `Task` replié masque ses descendants ; repli automatique à l'arrivée du `result` ; un `Task` déplié à la main **ne** se replie pas ; profondeur 2.
- **`ThinkingBlock`** : replié par défaut, bascule, rendu markdown.
- **Serveur** : passe-plat de `parentToolUseId` sur deltas et `tool_use` ; émission d'un `thinking_delta` ; extraction des blocs `thinking` par `mapSessionMessages` ; index des sous-agents avec un sidecar manquant ; `GET` d'un `agentId` inconnu.
- **Vérification réelle** : la sonde SDK en amont (source de texte unique) et, en fin de parcours, un tour réel avec sous-agent observé de bout en bout — live puis rechargement — comme pour le QCM et l'autopilot.

## Hors périmètre

- Vue agrégée type `/workflows` (arbre global, phases, compteurs de tokens par agent).
- Métriques par sous-agent (durée, tokens) : le sidecar ne les porte pas.
- Interaction avec un sous-agent en cours (interruption ciblée, redirection).
- Recherche dans les transcripts de sous-agents.

## Notes de contexte

- `apps/server/src/sdk/sdk-client.ts` porte une modification non commitée (nettoyage du transcript de la sonde `listCommands`) dans le fichier même que cette feature touche : à committer ou jeter avant de démarrer.
- Un worktree `.worktrees/review-merge` (branche `feat-review-merge`) est actif en parallèle.
