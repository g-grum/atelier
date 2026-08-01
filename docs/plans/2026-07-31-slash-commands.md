# Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Taper `/review` dans le composer d'Atelier, avec autocomplétion des 68 commandes réelles (projet, plugins, natives), et l'exécuter.

**Architecture:** L'exécution est **gratuite** — une slash command part comme un `user_message` ordinaire et le CLI l'expanse ; aucun chemin d'exécution n'est ajouté. Tout le travail est la **découverte** : une sonde `query()` jetable, avortée sur `system/init`, lit `supportedCommands()` (source unique, aucun parsing de `.md`), exposée par `GET /api/projects/:id/commands` et rafraîchie en session par `commands_changed`.

**Tech Stack:** inchangé (Bun test runner, Hono, `@anthropic-ai/claude-agent-sdk` 0.3.198, React 19 + Tailwind v4, Electron).

**Spec:** `docs/specs/2026-07-31-slash-commands-design.md` — normative, gagne sur ce plan.

**Conventions:** TDD strict ; suite entière `bun test` verte (**baseline 484 pass / 42 fichiers**) ; `bunx tsc --noEmit` propre ; commits `feat:|fix:|test:|chore:` + trailer `(no trailer)` ; copie UI en français ; ambre réservé aux permissions ; coche tes propres cases dans CE fichier au commit final. Toutes les commandes depuis la racine du repo.

**Piège PATH (sous-agents) :** `bun` n'est pas dans le PATH d'un shell non interactif — utiliser le chemin absolu `/Users/demo/.bun/bin/bun`. Vérifie chaque gate toi-même, ne déclare jamais DONE sans l'avoir exécuté.

**Travail concurrent :** un autre agent commit dans `docs/specs/` sur d'autres specs. Ne touche qu'aux fichiers listés ici ; en cas de conflit git, rebase, ne force jamais.

---

## File structure (décisions verrouillées)

```
packages/shared/src/protocol.ts              # + SlashCommandInfo, + ServerEvent 'commands', + entrée du Set
apps/server/src/sdk/sdk-client.ts            # + listCommands(cwd), + mapping pur, + SdkTurnEvent 'commands'
apps/server/src/sdk/sdk-client.mock.ts       # + listCommands, + scénarisation de l'événement
apps/server/src/commands/commands-routes.ts  # NOUVEAU — GET /projects/:id/commands
apps/server/src/app.ts                       # monte la route (needs sdk)
apps/server/src/stream/session-stream.ts     # relaie l'événement de tour en ServerEvent
apps/web/src/lib/slash-commands.ts           # NOUVEAU — PUR : prefix / match / complete (+ test)
apps/web/src/state/stream-reducer.ts         # + commands: SlashCommandInfo[] | null
apps/web/src/api/client.ts                   # + listCommands
apps/web/src/api/backend.ts                  # + listCommands dans Backend + fixture
apps/web/src/components/Composer.tsx         # + prop commands, popover, clavier
apps/web/src/App.tsx                         # rend <Composer> (:423) — câble react-query → prop
apps/web/src/App.test.tsx                    # fakeBackend() gagne listCommands
apps/web/src/styles.css                      # styles du popover
```

**Décision de découpage :** toute la logique de matching vit dans un module **pur** (`lib/slash-commands.ts`) testé isolément ; `Composer.tsx` ne garde que le rendu et le clavier. Sans cette séparation, les 12 cas de test du composer devraient tous passer par le DOM.

---

## Chunk 1: Contrat partagé + découverte serveur

### Task 1.1: `SlashCommandInfo` + événement `commands` dans le protocole

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Test: `packages/shared/src/protocol.test.ts` (créer s'il n'existe pas)

- [ ] **Step 1: Écrire le test qui échoue.** Dans `protocol.test.ts` :

```ts
import { describe, expect, test } from 'bun:test'
import { isServerEvent } from './protocol'

describe('isServerEvent', () => {
  test('accepte un événement commands', () => {
    expect(isServerEvent({ type: 'commands', sessionId: 's1', commands: [] })).toBe(true)
  })
})
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `/Users/demo/.bun/bin/bun test packages/shared/src/protocol.test.ts`
Expected: FAIL — `isServerEvent` renvoie `false` (`'commands'` absent du `Set`).

- [ ] **Step 3: Implémenter.** Dans `protocol.ts`, après `ChatMessage` (~ligne 89) :

```ts
/**
 * Une slash command proposée à l'autocomplétion. `name` est SANS le slash
 * initial (contrat SDK). `aliases` porte les noms courts des commandes
 * namespacées (`superpowers:brainstorming` → `brainstorming`) : le filtrage
 * DOIT les inclure, sinon les commandes de plugins sont introuvables.
 */
export type SlashCommandInfo = { name: string; description: string; argumentHint: string; aliases: string[] }
```

Ajouter la variante à `ServerEvent` (après la ligne `status`, ~117) :

```ts
  | { type: 'commands'; sessionId: string; commands: SlashCommandInfo[] }
```

Et — **le piège** — ajouter `'commands'` au `Set` ligne 119 :

```ts
const SERVER_EVENT_TYPES = new Set(['assistant_delta', 'tool_use', 'tool_result', 'permission_request', 'usage', 'rate_limit', 'status', 'commands'])
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `/Users/demo/.bun/bin/bun test packages/shared/src/protocol.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/protocol.test.ts
git commit -m "feat(shared): SlashCommandInfo + événement serveur commands

(no trailer)"
```

---

### Task 1.2: Mapping pur `SlashCommand → SlashCommandInfo`

Couture testable pour un contrat de frontière que le mock ne voit pas — même justification que `mapUsageWindows` (`sdk-client.ts:326`).

**Files:**
- Modify: `apps/server/src/sdk/sdk-client.ts`
- Test: `apps/server/src/sdk/sdk-client.test.ts`

- [ ] **Step 1: Écrire le test qui échoue.** Ajouter à `sdk-client.test.ts` :

```ts
import { toSlashCommandInfo } from './sdk-client'

describe('toSlashCommandInfo', () => {
  test('mappe les champs et normalise aliases absent en tableau vide', () => {
    expect(toSlashCommandInfo([
      { name: 'review', description: 'Review (project)', argumentHint: '<file>' },
      { name: 'superpowers:brainstorming', description: '(superpowers) …', argumentHint: '', aliases: ['brainstorming'] },
    ] as never)).toEqual([
      { name: 'review', description: 'Review (project)', argumentHint: '<file>', aliases: [] },
      { name: 'superpowers:brainstorming', description: '(superpowers) …', argumentHint: '', aliases: ['brainstorming'] },
    ])
  })

  test('remplace les champs manquants par des chaînes vides', () => {
    expect(toSlashCommandInfo([{ name: 'x' }] as never)).toEqual([{ name: 'x', description: '', argumentHint: '', aliases: [] }])
  })
})
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `/Users/demo/.bun/bin/bun test apps/server/src/sdk/sdk-client.test.ts`
Expected: FAIL — `toSlashCommandInfo` n'est pas exporté.

- [ ] **Step 3: Implémenter.** Dans `sdk-client.ts`, section Helpers :

```ts
/**
 * Mappe les SlashCommand du SDK vers notre DTO. Couture testable pour l'écart
 * de frontière qui compte : `aliases` est OPTIONNEL côté SDK
 * (`aliases?: string[]`) mais requis chez nous — un `undefined` casserait le
 * filtrage du composer. `description`/`argumentHint` sont déclarés requis par
 * le SDK ; les `??` ne sont qu'une ceinture (argumentHint est souvent la chaîne
 * vide — renseigné sur ~20 des 68 commandes observées — mais jamais absent).
 */
export function toSlashCommandInfo(commands: readonly SlashCommand[]): SlashCommandInfo[] {
  return commands.map((c) => ({
    name: c.name,
    description: c.description ?? '',
    argumentHint: c.argumentHint ?? '',
    aliases: c.aliases ?? [],
  }))
}
```

Ajouter `SlashCommand` à l'import du SDK (ligne 4-13) et `SlashCommandInfo` à l'import `@atelier/shared` (ligne 14).

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `/Users/demo/.bun/bin/bun test apps/server/src/sdk/sdk-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sdk/sdk-client.ts apps/server/src/sdk/sdk-client.test.ts
git commit -m "feat(server): mapping pur SlashCommand vers SlashCommandInfo

(no trailer)"
```

---

### Task 1.3: `listCommands(cwd)` — la sonde jetable

**Files:**
- Modify: `apps/server/src/sdk/sdk-client.ts`
- Modify: `apps/server/src/sdk/sdk-client.mock.ts`
- Test: `apps/server/src/sdk/sdk-client.mock.test.ts` (créer)

⚠️ **La vraie sonde n'est pas testable en unitaire** (elle lance le CLI). Le test couvre le mock et le contrat ; la sonde réelle a été validée par spike (voir spec § Spikes).

- [ ] **Step 1: Écrire le test qui échoue.** Créer `sdk-client.mock.test.ts` :

```ts
import { describe, expect, test } from 'bun:test'
import { MockSdkClient } from './sdk-client.mock'

describe('MockSdkClient.listCommands', () => {
  test('renvoie les commandes scénarisées et enregistre l’appel', async () => {
    const mock = new MockSdkClient({ commands: [{ name: 'review', description: 'r', argumentHint: '', aliases: [] }] })
    expect(await mock.listCommands('/tmp/p')).toEqual([{ name: 'review', description: 'r', argumentHint: '', aliases: [] }])
    expect(mock.calls).toContainEqual({ method: 'listCommands', args: ['/tmp/p'] })
  })

  test('renvoie [] par défaut', async () => {
    expect(await new MockSdkClient().listCommands('/tmp/p')).toEqual([])
  })
})
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `/Users/demo/.bun/bin/bun test apps/server/src/sdk/sdk-client.mock.test.ts`
Expected: FAIL — `listCommands` n'existe pas sur `MockSdkClient`.

- [ ] **Step 3a: Étendre l'interface.** Dans `sdk-client.ts`, dans `interface SdkClient` (ligne 44-50) :

```ts
  /** Liste des slash commands du répertoire. Ne jette jamais — [] en cas d'échec. */
  listCommands(cwd: string): Promise<SlashCommandInfo[]>
```

- [ ] **Step 3b: Implémenter la sonde** dans `AgentSdkClient` :

```ts
  /**
   * Sonde jetable : `supportedCommands()` vit sur l'objet Query, qui n'existe
   * que pendant un tour — on en ouvre donc un et on l'avorte sur `init`.
   *
   * Le `prompt` DOIT être une string non vide. Mesuré (spec § Spikes) : en mode
   * streaming input, un itérable qui ne yield jamais bloque (>5 min) et un
   * itérable vide ne produit que des `system/hook_*` — dans les deux cas
   * l'`init` dont la sonde dépend n'arrive JAMAIS. L'abort sur `init` précède
   * tout message assistant/result : aucun tour modèle n'aboutit et aucun
   * transcript n'est créé.
   *
   * Coût ~3,8 s → le client met en cache (react-query), le serveur non.
   */
  async listCommands(cwd: string): Promise<SlashCommandInfo[]> {
    const abortController = new AbortController()
    try {
      const q = query({
        prompt: 'atelier: command discovery probe',
        options: { cwd, abortController },
      })
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          const commands = await q.supportedCommands()
          abortController.abort()
          return toSlashCommandInfo(commands)
        }
      }
      return []
    } catch {
      // Ne jette jamais (politique deriveMessageCount) : l'autocomplétion est
      // un confort, son échec ne doit rien casser.
      return []
    } finally {
      abortController.abort()
    }
  }
```

- [ ] **Step 3c: Étendre le mock.** Dans `sdk-client.mock.ts` : ajouter `commands?: SlashCommandInfo[]` à `MockOptions`, le champ privé `private readonly commands: SlashCommandInfo[]`, l'affectation dans le constructeur (`commands = []` par défaut), et :

```ts
  async listCommands(cwd: string): Promise<SlashCommandInfo[]> {
    this.calls.push({ method: 'listCommands', args: [cwd] })
    return this.commands
  }
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `/Users/demo/.bun/bin/bun test apps/server/src/sdk/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sdk/
git commit -m "feat(server): sonde de découverte listCommands

(no trailer)"
```

---

### Task 1.4: Route `GET /api/projects/:id/commands`

**Files:**
- Create: `apps/server/src/commands/commands-routes.ts`
- Create: `apps/server/src/commands/commands-routes.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: Écrire le test qui échoue.** Créer `commands-routes.test.ts`. Le helper reprend la construction `AppData` sur tmpdir d'`app.test.ts:20-22`, en montant la route seule (pas `createApp`) — donc **pas de header d'auth** à fournir, le middleware token vit dans `createApp` :

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockSdkClient } from '../sdk/sdk-client.mock'
import { AppData } from '../store/app-data'
import { commandsRoutes } from './commands-routes'

const CMD = { name: 'review', description: 'Relire', argumentHint: '<file>', aliases: [] }

/** AppData réel sur un tmpdir jetable (même motif que freshApp, app.test.ts:20-22). */
function freshRoutes(sdk: MockSdkClient = new MockSdkClient(), withProject = true) {
  const data = new AppData(join(mkdtempSync(join(tmpdir(), 'atelier-cmds-')), 'data.json'))
  if (withProject) data.update((d) => { d.projects.push({ id: 'p1', path: '/tmp/p1', color: '#ffffff' }) })
  return { app: commandsRoutes(data, sdk), data }
}

describe('GET /projects/:id/commands', () => {
  test('renvoie la liste pour un projet connu, sondé sur son path', async () => {
    const sdk = new MockSdkClient({ commands: [CMD] })
    const { app } = freshRoutes(sdk)
    const res = await app.request('/projects/p1/commands')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([CMD])
    expect(sdk.calls).toContainEqual({ method: 'listCommands', args: ['/tmp/p1'] })
  })

  test('404 sur projet inconnu', async () => {
    const { app } = freshRoutes(new MockSdkClient(), false)
    expect((await app.request('/projects/nope/commands')).status).toBe(404)
  })

  test('200 avec [] quand la sonde jette', async () => {
    const sdk = new MockSdkClient()
    sdk.listCommands = async () => { throw new Error('boom') }
    const { app } = freshRoutes(sdk)
    const res = await app.request('/projects/p1/commands')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `/Users/demo/.bun/bin/bun test apps/server/src/commands/`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter.** Créer `commands-routes.ts` :

```ts
import { Hono } from 'hono'
import type { SdkClient } from '../sdk/sdk-client'
import type { AppData } from '../store/app-data'

/**
 * Slash commands d'un projet, via la sonde SDK.
 *
 * Résolution de l'id : il n'existe AUCUN résolveur partagé au HEAD —
 * sessions-routes.ts:12 et github-routes.ts:17 inlinent chacun leur
 * projects.find. On fait de même. Conséquence assumée : un id de worktree
 * (`wt:`) donne 404 tant que le plan worktrees n'a pas atterri ; cette route
 * sera alors un sixième site à élargir, pas un travail nouveau.
 */
export function commandsRoutes(data: AppData, sdk: SdkClient): Hono {
  const app = new Hono()

  app.get('/projects/:id/commands', async (c) => {
    const { id } = c.req.param()
    const project = data.get().projects.find((p) => p.id === id)
    if (!project) return c.json({ error: 'Not found' }, 404)
    // Ceinture et bretelles : listCommands ne jette pas, mais un throw ici
    // priverait le composer de sa liste ET renverrait un 500 pour un confort.
    try {
      return c.json(await sdk.listCommands(project.path))
    } catch {
      return c.json([])
    }
  })

  return app
}
```

- [ ] **Step 4a: Monter la route.** Dans `app.ts` (ligne 37-39) :

```ts
  api.route('/', commandsRoutes(data, sdk))
```

`sdk` est déjà un paramètre de `createApp` (ligne 19) — ne pas modifier la signature.

- [ ] **Step 4b: Lancer les tests, vérifier le succès**

Run: `/Users/demo/.bun/bin/bun test apps/server/`
Expected: PASS (aucune régression)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/commands/ apps/server/src/app.ts
git commit -m "feat(server): route GET /projects/:id/commands

(no trailer)"
```

---

## Chunk 2: Rafraîchissement live (`commands_changed`)

### Task 2.1: Émettre l'événement de tour sur `commands_changed`

**Files:**
- Modify: `apps/server/src/sdk/sdk-client.ts`
- Test: `apps/server/src/sdk/sdk-client.test.ts`

⚠️ **On n'ajoute PAS de sonde `supportedCommands()` à l'init du tour** : le bloc `init` (`sdk-client.ts:104-121`) `await`e déjà la sonde `usage` avant le premier delta ; une seconde sonde séquentielle de ~2 s retarderait le premier token de **chaque** tour. La liste initiale vient de la route (Task 1.4).

- [ ] **Step 1: Étendre le type.** Dans `SdkTurnEvent` (`sdk-client.ts:21-29`) :

```ts
  | { type: 'commands'; commands: SlashCommandInfo[] }
```

- [ ] **Step 2: Implémenter l'émission.** Dans la boucle `for await` de `runTurn`, **après** le bloc `system`/`init` existant :

```ts
        // SDKCommandsChangedMessage (sdk.d.ts:2782) : la liste a changé en cours
        // de session (skills découverts dynamiquement…). Le contrat SDK est
        // explicite — le client REMPLACE sa liste, il ne fusionne pas.
        if (msg.type === 'system' && msg.subtype === 'commands_changed') {
          yield { type: 'commands', commands: toSlashCommandInfo(msg.commands) }
          continue
        }
```

- [ ] **Step 3: Vérifier le typage**

Run: `cd apps/server && /Users/demo/.bun/bin/bunx tsc --noEmit; cd ../..`
Expected: aucune erreur (le narrowing marche : `SDKCommandsChangedMessage` est dans l'union `SDKMessage`, `sdk.d.ts:3736`).

- [ ] **Step 4: Lancer la suite serveur**

Run: `/Users/demo/.bun/bin/bun test apps/server/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sdk/sdk-client.ts
git commit -m "feat(server): événement de tour commands sur commands_changed

(no trailer)"
```

---

### Task 2.2: Relayer en `ServerEvent` depuis le stream

**Files:**
- Modify: `apps/server/src/stream/session-stream.ts`
- Test: `apps/server/src/stream/session-stream.test.ts`

- [ ] **Step 1: Écrire le test qui échoue.** Dans `session-stream.test.ts`, en réutilisant les helpers déjà présents en tête de fichier (`setup` :16, `makeSink` :28, `clientMessage` :40, `tick` :14) :

```ts
test('diffuse l’événement commands avec le sessionId', async () => {
  const CMD = { name: 'review', description: 'r', argumentHint: '', aliases: [] }
  const { registry } = setup({ turns: [[{ type: 'commands', commands: [CMD] }, { type: 'turn_done' }]] })
  const stream = registry.get('s1', 'p1')
  const { events, send } = makeSink()

  stream.onConnect(send)
  stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
  await tick()

  expect(events).toContainEqual({ type: 'commands', sessionId: 's1', commands: [CMD] })
})
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `/Users/demo/.bun/bin/bun test apps/server/src/stream/session-stream.test.ts`
Expected: FAIL — aucun événement `commands` diffusé.

- [ ] **Step 3: Implémenter.** Dans `handleTurnEvent` (`session-stream.ts:177`), ajouter un `case` :

```ts
      case 'commands':
        this.broadcast({ type: 'commands', sessionId: this.sessionId(), commands: event.commands })
        return
```

`this.sessionId()` (`session-stream.ts:292`) est l'accesseur privé utilisé **tel quel** par tous les `case` voisins (`tool_use` :188, `tool_result` :196, `usage` :212, `rate_limit` :230) — il résout l'id draft → id SDK après matérialisation. N'en invente pas un autre.

- [ ] **Step 4: Lancer les tests, vérifier le succès**

Run: `/Users/demo/.bun/bin/bun test apps/server/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/stream/session-stream.ts apps/server/src/stream/session-stream.test.ts
git commit -m "feat(server): diffusion de l'événement commands

(no trailer)"
```

---

## Chunk 3: Web — matching pur, état, autocomplétion

### Task 3.1: Module pur `lib/slash-commands.ts`

Toute la logique de matching vit ici pour être testée sans DOM.

**Files:**
- Create: `apps/web/src/lib/slash-commands.ts`
- Create: `apps/web/src/lib/slash-commands.test.ts`

- [ ] **Step 1: Écrire le test qui échoue.**

```ts
import { describe, expect, test } from 'bun:test'
import { commandPrefix, completeCommand, matchCommands } from './slash-commands'

const CMDS = [
  { name: 'review', description: '', argumentHint: '', aliases: [] },
  { name: 'superpowers:brainstorming', description: '', argumentHint: '', aliases: ['brainstorming'] },
]

describe('commandPrefix', () => {
  test('renvoie le préfixe quand le brouillon commence par /', () => {
    expect(commandPrefix('/rev', 4)).toBe('rev')
  })
  test('renvoie une chaîne vide juste après le slash', () => {
    expect(commandPrefix('/', 1)).toBe('')
  })
  test('ne déclenche pas hors du premier mot', () => {
    expect(commandPrefix('/review mon-fichier', 19)).toBeNull()
  })
  test('déclenche si le curseur revient dans le premier mot', () => {
    expect(commandPrefix('/review mon-fichier', 4)).toBe('review')
  })
  test('ne déclenche pas sur un chemin en milieu de phrase', () => {
    expect(commandPrefix('regarde src/foo', 15)).toBeNull()
  })
})

describe('matchCommands', () => {
  test('filtre sur le nom', () => {
    expect(matchCommands(CMDS, 'rev').map((c) => c.name)).toEqual(['review'])
  })
  test('filtre AUSSI sur les alias', () => {
    expect(matchCommands(CMDS, 'brain').map((c) => c.name)).toEqual(['superpowers:brainstorming'])
  })
  test('renvoie tout sur préfixe vide', () => {
    expect(matchCommands(CMDS, '')).toHaveLength(2)
  })
  test('est insensible à la casse', () => {
    expect(matchCommands(CMDS, 'REV').map((c) => c.name)).toEqual(['review'])
  })
})

describe('completeCommand', () => {
  test('complète et ajoute une espace quand il n’y a pas de reste', () => {
    expect(completeCommand('/rev', 'review')).toBe('/review ')
  })
  test('remplace le PREMIER TOKEN SEULEMENT et préserve le reste', () => {
    expect(completeCommand('/rev mon-fichier', 'review')).toBe('/review mon-fichier')
  })
})
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `/Users/demo/.bun/bin/bun test apps/web/src/lib/slash-commands.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter.**

```ts
import type { SlashCommandInfo } from '@atelier/shared'

/**
 * Le token de commande en cours de frappe, ou null si le brouillon n'est pas
 * un préfixe de slash command. Déclenchement volontairement STRICT : le
 * brouillon doit commencer par '/' (position 0) et le curseur rester dans le
 * premier mot — sinon `src/foo` ou une URL ouvrirait le popover en pleine phrase.
 */
export function commandPrefix(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null
  const firstBreak = text.search(/\s/)
  const tokenEnd = firstBreak === -1 ? text.length : firstBreak
  if (caret > tokenEnd) return null
  return text.slice(1, tokenEnd)
}

/** Filtre par préfixe sur le nom ET sur les alias (les commandes réelles sont namespacées). */
export function matchCommands(commands: readonly SlashCommandInfo[], prefix: string): SlashCommandInfo[] {
  const p = prefix.toLowerCase()
  return commands.filter(
    (c) => c.name.toLowerCase().startsWith(p) || c.aliases.some((a) => a.toLowerCase().startsWith(p)),
  )
}

/**
 * Remplace le PREMIER TOKEN seulement, en préservant le reste du brouillon —
 * une réécriture complète perdrait l'argument déjà tapé (cas réel : le curseur
 * peut revenir dans `review` sur `/review mon-fichier`).
 */
export function completeCommand(text: string, name: string): string {
  const firstBreak = text.search(/\s/)
  return firstBreak === -1 ? `/${name} ` : `/${name}${text.slice(firstBreak)}`
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `/Users/demo/.bun/bin/bun test apps/web/src/lib/slash-commands.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/slash-commands.ts apps/web/src/lib/slash-commands.test.ts
git commit -m "feat(web): module pur de matching des slash commands

(no trailer)"
```

---

### Task 3.2: État `commands` dans le reducer

**Files:**
- Modify: `apps/web/src/state/stream-reducer.ts`
- Test: `apps/web/src/state/stream-reducer.test.ts`

- [ ] **Step 1: Écrire le test qui échoue.**

```ts
test('stocke la liste sur l’événement commands', () => {
  const cmds = [{ name: 'review', description: '', argumentHint: '', aliases: [] }]
  const next = reduce(initialState(), { type: 'commands', sessionId: 's1', commands: cmds })
  expect(next.commands).toEqual(cmds)
})

test('vaut null avant tout événement', () => {
  expect(initialState().commands).toBeNull()
})

test('revient à null au resync (reset)', () => {
  expect(reset([]).commands).toBeNull()
})
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `/Users/demo/.bun/bin/bun test apps/web/src/state/stream-reducer.test.ts`
Expected: FAIL — `commands` n'existe pas sur `StreamState`.

- [ ] **Step 3: Implémenter.** Dans `StreamState` (ligne 25-30) :

```ts
  /**
   * Liste poussée par le SDK (commands_changed). null = jamais reçue.
   * Par-session et reconstruite par reset() au resync : la liste est alors
   * perdue et l'UI retombe sur celle de react-query (clefée par projet, même
   * origine SDK). Comportement ASSUMÉ, documenté dans la spec §5 — pas un bug.
   */
  commands: SlashCommandInfo[] | null
```

Dans `initialState()` : `commands: null,`. Dans `reduce`, un `case` :

```ts
    case 'commands':
      return { ...state, commands: event.commands }
```

`reset()` appelle déjà `initialState()` → `null` gratuitement.

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `/Users/demo/.bun/bin/bun test apps/web/src/state/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state/stream-reducer.ts apps/web/src/state/stream-reducer.test.ts
git commit -m "feat(web): état commands dans le stream-reducer

(no trailer)"
```

---

### Task 3.3: Couche API web

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/backend.ts`

- [ ] **Step 1: Implémenter le client.** Dans `client.ts`, près de `getProjectGithubAccount` (ligne 164) :

```ts
/** Slash commands disponibles dans le projet (sonde SDK côté serveur, ~3,8 s au premier appel). */
export function listCommands(projectId: string): Promise<SlashCommandInfo[]> {
  return request<SlashCommandInfo[]>('GET', `/projects/${encodeURIComponent(projectId)}/commands`)
}
```

- [ ] **Step 2: Étendre `Backend`.** Dans `backend.ts`, dans le type `Backend` :

```ts
  /** Slash commands du projet — alimente l'autocomplétion du composer. */
  listCommands: (projectId: string) => Promise<SlashCommandInfo[]>
```

Ajouter aussi `SlashCommandInfo` à l'import type en tête de `client.ts` **et** de `backend.ts`.

**Trois sites implémentent `Backend` — les trois doivent gagner l'entrée, sinon le typage casse :**

1. `apps/web/src/api/backend.ts` → `realBackend` : `listCommands,` (la vraie fonction importée de `client.ts`)
2. `apps/web/src/api/backend.ts` → l'objet renvoyé par `createFixtureBackend()` : `listCommands: async () => []`
3. `apps/web/src/App.test.tsx` → `fakeBackend()` : `listCommands: async () => []`

⚠️ Le site 3 a un type de retour explicite `Backend` : l'oublier casse **toute** la suite `App.test.tsx` au typecheck. (`state/fixtures.ts` ne contient que des données brutes, aucun objet `Backend` — rien à y faire.)

- [ ] **Step 3: Vérifier le typage**

Run: `cd apps/web && /Users/demo/.bun/bin/bunx tsc --noEmit; cd ../..`
Expected: aucune erreur. Toute erreur « property listCommands is missing » désigne une fixture oubliée — la compléter.

- [ ] **Step 4: Lancer la suite web**

Run: `/Users/demo/.bun/bin/bun test apps/web/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/
git commit -m "feat(web): listCommands dans la couche API

(no trailer)"
```

---

### Task 3.4: Autocomplétion dans le composer

**Files:**
- Modify: `apps/web/src/components/Composer.tsx`
- Modify: `apps/web/src/components/Composer.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1a: Étendre le helper existant.** `renderComposer` (`Composer.test.tsx:10-26`) construit un `ComposerProps` complet ; la prop `commands` devenant requise, **les 100 % des tests existants cassent au typage** sans un défaut. Ajouter dans l'objet `props`, avant le spread `...overrides` :

```ts
    commands: [],
```

- [ ] **Step 1b: Écrire les tests qui échouent.** Ajouter à `Composer.test.tsx` :

```ts
const CMDS = [
  { name: 'review', description: 'Relire', argumentHint: '<file>', aliases: [] },
  { name: 'superpowers:brainstorming', description: 'Brainstorm', argumentHint: '', aliases: ['brainstorming'] },
]

/** Frappe en positionnant le curseur en fin de texte (le déclenchement dépend du caret). */
function type(value: string) {
  const el = textarea() as HTMLTextAreaElement
  fireEvent.change(el, { target: { value, selectionStart: value.length } })
}

const options = () => screen.queryAllByRole('option')
```

Exemple complet du cas le plus subtil (les 10 autres suivent le même moule) :

```ts
test('Enter complète sans envoyer quand le popover est ouvert', () => {
  const { sent } = renderComposer({ commands: CMDS })
  type('/rev')
  expect(options()).toHaveLength(1)
  fireEvent.keyDown(textarea(), { key: 'Enter' })
  expect(sent).toEqual([])                                    // rien n'est parti
  expect((textarea() as HTMLTextAreaElement).value).toBe('/review ')
})

test('zéro résultat : Enter envoie', () => {
  const { sent } = renderComposer({ commands: CMDS })
  type('/zzz')
  expect(options()).toHaveLength(0)
  fireEvent.keyDown(textarea(), { key: 'Enter' })
  expect(sent).toEqual(['/zzz'])
})
```

Cas à couvrir (un `it` par ligne) :
1. taper `/rev` affiche une option `review`
2. taper `/brain` affiche `superpowers:brainstorming` (**filtrage par alias**)
3. `Enter` popover ouvert **complète et n'envoie pas** (`onSend` non appelé, textarea = `/review `) — cas détaillé plus bas
4. `Tab` complète comme `Enter`
5. un clic sur une option complète
6. `↓` puis `Enter` sélectionne la **deuxième** option
7. **zéro résultat** (`/zzz`) ⇒ `Enter` **envoie** (`onSend` appelé avec `/zzz`)
8. `⌘↵` envoie **même popover ouvert**
9. `Esc` ferme le popover **en gardant le texte**
10. `regarde src/foo` **n'ouvre pas** le popover
11. prop `commands` vide ⇒ **jamais** de popover
12. **Shift+Enter popover ouvert insère une nouvelle ligne** — ne complète pas, n'envoie pas (`onSend` non appelé, la valeur n'est pas devenue `/review `)

- [ ] **Step 2: Lancer les tests, vérifier l'échec**

Run: `/Users/demo/.bun/bin/bun test apps/web/src/components/Composer.test.tsx`
Expected: FAIL sur les nouveaux cas.

- [ ] **Step 3: Implémenter.** Dans `Composer.tsx` :

- Ajouter à `ComposerProps` :

```ts
  /** Liste pour l'autocomplétion. Vide ⇒ aucun popover (dégradation silencieuse). */
  commands: SlashCommandInfo[]
```

- État local : `const [caret, setCaret] = useState(0)`, `const [active, setActive] = useState(0)`, `const [dismissed, setDismissed] = useState(false)`.
- Dérivés (pas d'état redondant) :

```ts
const prefix = dismissed ? null : commandPrefix(text, caret)
const matches = prefix === null ? [] : matchCommands(commands, prefix)
const open = matches.length > 0
```

- `onChange` met à jour `text`, `caret` (`event.target.selectionStart ?? 0`), remet `active` à 0 et `dismissed` à `false`.
- `onKeyDown`, **avant** la logique d'envoi existante :

```ts
// Deux échappatoires INCONDITIONNELLES, même popover ouvert :
//  - ⌘↵ envoie (testé explicitement)
//  - Shift+Enter insère une nouvelle ligne — sans le !shiftKey, le popover
//    volerait le saut de ligne dès qu'on est dans le premier mot.
if (open && !event.metaKey && !event.shiftKey) {
  if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => (i + 1) % matches.length); return }
  if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => (i - 1 + matches.length) % matches.length); return }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault()
    const next = completeCommand(text, matches[active]!.name)
    setText(next)
    setCaret(next.length)
    setDismissed(true)   // ne pas rouvrir immédiatement sur le nom complété
    return
  }
  if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return }
}
```

- Rendu du popover **au-dessus** de la textarea quand `open` :
  `<ul role="listbox">` + `<li role="option" aria-selected={i === active}>` avec `name`, `description`, et `argumentHint` **seulement s'il est non vide**. `onMouseDown` (pas `onClick` — `onClick` arriverait après le blur) déclenche la même complétion. `scrollIntoView` sur l'option active au changement de `active`.
- **Popover écrit à la main** : `components/ui/` n'a pas de primitive listbox (button, dialog, dropdown-menu, input, sonner, tooltip seulement).

- [ ] **Step 4: Lancer les tests, vérifier le succès**

Run: `/Users/demo/.bun/bin/bun test apps/web/src/components/Composer.test.tsx`
Expected: PASS (12 nouveaux cas)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Composer.tsx apps/web/src/components/Composer.test.tsx apps/web/src/styles.css
git commit -m "feat(web): autocomplétion des slash commands dans le composer

(no trailer)"
```

---

### Task 3.5: Câblage final

**Files:**
- Modify: `apps/web/src/App.tsx` (~ligne 423 — `<Composer>` y est rendu **en frère** de `<ChatView>`, pas à l'intérieur)

- [ ] **Step 1: Confirmer le point de rendu**

Run: `grep -rn "<Composer" apps/web/src`
Expected: une seule occurrence, dans `App.tsx`.

- [ ] **Step 2: Câbler.** Dans le parent : `useQuery` sur `['commands', projectId]` → `backend.listCommands(projectId)`, avec `staleTime: Infinity` (la sonde coûte ~3,8 s ; la liste ne bouge quasiment jamais) et `enabled` seulement si `projectId` est défini. Puis :

```tsx
commands={state.commands ?? restCommands ?? []}
```

Précédence **`wsCommands ?? restCommands`** (spec §5) : les deux viennent du même producteur (le SDK), le WS est juste plus frais — aucune fusion.

- [ ] **Step 3: Vérifier le typage**

Run: `cd apps/web && /Users/demo/.bun/bin/bunx tsc --noEmit; cd ../..`
Expected: aucune erreur

- [ ] **Step 4: Gate complet**

```bash
/Users/demo/.bun/bin/bun test
cd apps/server && /Users/demo/.bun/bin/bunx tsc --noEmit; cd ../..
cd apps/web && /Users/demo/.bun/bin/bunx tsc --noEmit; cd ../..
cd apps/desktop && /Users/demo/.bun/bin/bunx tsc --noEmit; cd ../..
```

Expected: **≥ 484 + nouveaux tests**, 0 fail, tsc propre partout.

- [ ] **Step 5: Vérification manuelle (obligatoire — aucun test ne couvre la vraie sonde)**

```bash
/Users/demo/.bun/bin/bun run build:web
```

Puis recharger Atelier (le serveur sert `apps/web/dist` depuis le disque) et vérifier : taper `/` ouvre le popover ; `/brain` trouve `superpowers:brainstorming` par alias ; `Enter` complète ; envoyer `/review` produit bien une réponse expansée par le CLI. Sans cette étape, rien ne prouve que la sonde marche hors spike.

- [ ] **Step 6: Commit final** (avec les cases de CE fichier cochées)

```bash
git add -A
git commit -m "feat(web): câblage de l'autocomplétion des slash commands

(no trailer)"
```
