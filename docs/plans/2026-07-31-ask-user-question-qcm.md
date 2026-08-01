# QCM natif (AskUserQuestion) — plan d'implémentation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre les QCM `AskUserQuestion` répondables dans Atelier — carte interactive dans le fil, réponses transmises au SDK via `updatedInput.answers`, y compris en mode skip-permissions.

**Architecture:** Un `QuestionBroker` dédié (frère du `PermissionBroker`) branché sur `canUseTool`, un événement WS `question_request` / message client `question_response`, une carte `QuestionPrompt` côté web. Le mode skip-permissions devient un auto-allow sélectif dans le callback (plus de `permissionMode: 'bypassPermissions'` SDK).

**Tech Stack:** Bun (runner `bun:test`), TypeScript, React 19 + Testing Library, Agent SDK 0.3.198.

**Spec :** `docs/specs/2026-07-31-ask-user-question-qcm-design.md` (fait foi en cas de doute).

**Conventions repo :**
- Tests : `bun test <chemin>` (tout : `bun test` — ~430 tests verts attendus).
- Identité git : locale au repo (g-grum) — ne PAS committer avec l'identité globale.
- NE PAS committer les fichiers modifiés par d'autres chantiers (`git add` ciblé uniquement).
- Ne pas tuer le serveur sur le port 4517 (app Atelier de Germain) — dev sur `ATELIER_PORT=4519` si besoin.
- Commentaires/messages de commit : français, style des fichiers existants.
- Typecheck : rien ne lance `tsc` (bun test transpile sans vérifier). Entre la fin du Chunk 1 et la Task 6, le switch exhaustif de `stream-reducer.ts` signalera `question_request` non géré dans l'IDE — attendu, résolu par la Task 6. Ne pas « corriger » autrement.

---

## Chunk 1 : protocole + serveur

### Task 1 : Types protocole (`question_request` / `question_response`)

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Test: `packages/shared/src/protocol.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `packages/shared/src/protocol.test.ts` :

```ts
describe('question protocol', () => {
  test('parseClientMessage accepte question_response avec answers', () => {
    const raw = JSON.stringify({ type: 'question_response', requestId: 'q1', answers: { 'Quelle lib ?': 'React' } })
    expect(parseClientMessage(raw)).toEqual({ type: 'question_response', requestId: 'q1', answers: { 'Quelle lib ?': 'React' } })
  })

  test('parseClientMessage accepte question_response sans answers (dismiss)', () => {
    const raw = JSON.stringify({ type: 'question_response', requestId: 'q1' })
    expect(parseClientMessage(raw)).toEqual({ type: 'question_response', requestId: 'q1' })
  })

  test('isServerEvent accepte question_request', () => {
    expect(
      isServerEvent({ type: 'question_request', sessionId: 's1', requestId: 'q1', questions: [] }),
    ).toBe(true)
  })
})
```

- [ ] **Step 2 : Vérifier l'échec** — Run: `bun test packages/shared` — Expected: FAIL (les deux types ne sont pas dans les Sets).

- [ ] **Step 3 : Implémenter**

Dans `packages/shared/src/protocol.ts` :

1. Après `ProposedRule` (L20), ajouter :

```ts
// ── QCM (spec 2026-07-31-ask-user-question-qcm) ──
/** Miroir de AskUserQuestionInput.questions[] (SDK sdk-tools.d.ts). */
export type QcmOption = { label: string; description: string; preview?: string }
export type QcmQuestion = { question: string; header: string; options: QcmOption[]; multiSelect: boolean }
```

2. Dans `ClientMessage`, ajouter la variante :

```ts
  /** answers ABSENT = « répondu en texte » (dismiss). Multi-select : valeurs jointes par virgule. « Autre » : le texte libre est la valeur. */
  | { type: 'question_response'; requestId: string; answers?: Record<string, string> }
```

3. Après `PermissionRequest`, ajouter :

```ts
export type QuestionRequest = {
  type: 'question_request'
  requestId: string
  questions: QcmQuestion[]
}
```

4. Dans `ServerEvent`, ajouter la variante `| (QuestionRequest & { sessionId: string })`.

5. `SERVER_EVENT_TYPES` gagne `'question_request'`, `CLIENT_MESSAGE_TYPES` gagne `'question_response'`.

6. Mettre à jour la docstring de `SessionPermissionMode` :

```ts
/**
 * Per-session permission behavior for SDK turns. 'bypassPermissions' est un
 * auto-allow sélectif dans canUseTool (tout sauf AskUserQuestion — le QCM
 * remonte toujours à la UI) ; le mode SDK 'bypassPermissions' n'est plus utilisé.
 */
```

- [ ] **Step 4 : Vérifier le vert** — Run: `bun test packages/shared` — Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/protocol.test.ts
git commit -m "feat(shared): protocole QCM — question_request / question_response"
```

### Task 2 : Seam SDK — `updatedInput` transite

**Files:**
- Modify: `apps/server/src/sdk/sdk-client.ts` (type `CanUseTool` L31, `buildQueryOptions` L254-258)
- Test: `apps/server/src/sdk/sdk-client.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

Dans `sdk-client.test.ts`, repérer les tests existants de `buildQueryOptions` (le canUseTool wrappé — le helper existant s'appelle `makeRunTurnParams`, L8) et ajouter :

```ts
test('canUseTool fait transiter updatedInput du résultat', async () => {
  const options = buildQueryOptions(
    makeRunTurnParams({ canUseTool: async () => ({ behavior: 'allow', updatedInput: { questions: [], answers: { Q: 'R' } } }) }),
    new AbortController(),
  )
  const result = await options.canUseTool!('AskUserQuestion', { questions: [] }, {} as never)
  expect(result).toEqual({ behavior: 'allow', updatedInput: { questions: [], answers: { Q: 'R' } } })
})
```

Nota : le cas « sans updatedInput → ré-échoe l'input original » est DÉJÀ couvert par le
test existant (L50-65) — le garder tel quel, il valide la non-régression du contrat CLI bundlé.

- [ ] **Step 2 : Vérifier l'échec** — Run: `bun test apps/server/src/sdk` — Expected: FAIL sur le nouveau test (updatedInput écrasé).

- [ ] **Step 3 : Implémenter**

```ts
// L31 — la branche allow gagne updatedInput (rempli par le QuestionBroker) :
export type CanUseTool = (
  toolName: string,
  input: unknown,
) => Promise<{ behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string }>
```

```ts
// buildQueryOptions — le fallback ?? input préserve le contrat CLI bundlé (updatedInput Zod-requis) :
canUseTool: async (toolName, input) => {
  const result = await params.canUseTool(toolName, input)
  if (result.behavior === 'allow') return { behavior: 'allow', updatedInput: result.updatedInput ?? input }
  return { behavior: 'deny', message: result.message }
},
```

- [ ] **Step 4 : Vérifier le vert** — Run: `bun test apps/server` — Expected: PASS (les tests broker/stream existants compilent : la nouvelle propriété est optionnelle).

- [ ] **Step 5 : Commit**

```bash
git add apps/server/src/sdk/sdk-client.ts apps/server/src/sdk/sdk-client.test.ts
git commit -m "feat(server): buildQueryOptions fait transiter updatedInput (réponses QCM)"
```

### Task 3 : `QuestionBroker`

**Files:**
- Create: `apps/server/src/stream/question-broker.ts`
- Test: `apps/server/src/stream/question-broker.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

`apps/server/src/stream/question-broker.test.ts` (s'inspirer de la structure de `permission-broker.test.ts`) :

```ts
import { describe, expect, test } from 'bun:test'
import type { QuestionRequest } from '@atelier/shared'
import { QuestionBroker } from './question-broker'

const VALID_INPUT = {
  questions: [
    {
      question: 'Quelle approche ?',
      header: 'Approche',
      options: [
        { label: 'A', description: 'la première' },
        { label: 'B', description: 'la seconde', preview: 'code' },
      ],
      multiSelect: false,
    },
  ],
}

function makeBroker(): { broker: QuestionBroker; published: QuestionRequest[] } {
  const published: QuestionRequest[] = []
  const broker = new QuestionBroker((request) => published.push(request))
  return { broker, published }
}

// ⚠️ tsconfig : noUncheckedIndexedAccess est actif — indexer published[0] exige
// l'assertion non-null (published[0]!.requestId), comme dans session-stream.test.ts.

describe('QuestionBroker', () => {
  test('publie un question_request avec les questions parsées', () => {
    const { broker, published } = makeBroker()
    void broker.request(VALID_INPUT)
    expect(published).toHaveLength(1)
    expect(published[0]!.type).toBe('question_request')
    expect(published[0]!.questions).toEqual(VALID_INPUT.questions)
  })

  test('resolve avec answers → allow avec updatedInput = input original + answers', async () => {
    const { broker, published } = makeBroker()
    const promise = broker.request(VALID_INPUT)
    broker.resolve(published[0]!.requestId, { 'Quelle approche ?': 'A' })
    expect(await promise).toEqual({
      behavior: 'allow',
      updatedInput: { ...VALID_INPUT, answers: { 'Quelle approche ?': 'A' } },
    })
  })

  test('resolve sans answers → deny « répondu dans le chat »', async () => {
    const { broker, published } = makeBroker()
    const promise = broker.request(VALID_INPUT)
    broker.resolve(published[0]!.requestId, undefined)
    expect(await promise).toEqual({ behavior: 'deny', message: "L'utilisateur a répondu directement dans le chat" })
  })

  test('answers de forme invalide → no-op, la question reste répondable', async () => {
    const { broker, published } = makeBroker()
    const promise = broker.request(VALID_INPUT)
    broker.resolve(published[0]!.requestId, { q: 42 } as never)
    expect(broker.pending()).toHaveLength(1)
    broker.resolve(published[0]!.requestId, { 'Quelle approche ?': 'A' })
    expect((await promise).behavior).toBe('allow')
  })

  test('input malformé → deny immédiat, rien de publié', async () => {
    const { broker, published } = makeBroker()
    expect(await broker.request({ nope: true })).toEqual({ behavior: 'deny', message: 'Entrée AskUserQuestion invalide' })
    expect(await broker.request({ questions: [] })).toMatchObject({ behavior: 'deny' })
    expect(await broker.request({ questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }] })).toMatchObject({ behavior: 'deny' })
    expect(published).toHaveLength(0)
    expect(broker.pending()).toHaveLength(0)
  })

  test('requestId inconnu → no-op', () => {
    const { broker } = makeBroker()
    broker.resolve('inconnu', { q: 'r' }) // ne throw pas
  })

  test('pending() liste les requêtes en attente, plus anciennes d’abord', () => {
    const { broker, published } = makeBroker()
    void broker.request(VALID_INPUT)
    void broker.request(VALID_INPUT)
    expect(broker.pending()).toEqual(published)
  })

  test('abort() deny tout et vide', async () => {
    const { broker } = makeBroker()
    const promise = broker.request(VALID_INPUT)
    broker.abort()
    expect(await promise).toEqual({ behavior: 'deny', message: 'Session aborted' })
    expect(broker.pending()).toHaveLength(0)
  })
})
```

- [ ] **Step 2 : Vérifier l'échec** — Run: `bun test apps/server/src/stream/question-broker.test.ts` — Expected: FAIL (module inexistant).

- [ ] **Step 3 : Implémenter** — `apps/server/src/stream/question-broker.ts` :

```ts
import { randomUUID } from 'node:crypto'
import type { QcmOption, QcmQuestion, QuestionRequest } from '@atelier/shared'
import type { CanUseTool } from '../sdk/sdk-client'

type PermissionResult = Awaited<ReturnType<CanUseTool>>

type Pending = {
  request: QuestionRequest
  /** Input original du SDK — ré-échoé tel quel dans updatedInput, answers ajouté. */
  input: Record<string, unknown>
  settle: (result: PermissionResult) => void
}

/**
 * Frère du PermissionBroker pour l'outil AskUserQuestion : une question se
 * RÉPOND (answers dans updatedInput), elle ne se décide pas — pas de règles
 * « always », pas de deny bouton. Même cycle de vie : pending ré-émis à la
 * reconnexion, abort = deny all, resolve one-shot fail-closed.
 */
export class QuestionBroker {
  private readonly requests = new Map<string, Pending>()

  constructor(private readonly sink: (event: QuestionRequest) => void) {}

  /** Entrée malformée → deny immédiat SANS publication : fail closed, le tour continue. */
  request(input: unknown): Promise<PermissionResult> {
    const questions = parseQuestions(input)
    if (questions === null) return Promise.resolve({ behavior: 'deny', message: 'Entrée AskUserQuestion invalide' })

    const request: QuestionRequest = { type: 'question_request', requestId: randomUUID(), questions }
    const promise = new Promise<PermissionResult>((settle) => {
      this.requests.set(request.requestId, { request, input: input as Record<string, unknown>, settle })
    })
    this.sink(request)
    return promise
  }

  /**
   * answers absent = « répondu en texte » (dismiss → deny). Présent mais de
   * forme invalide = no-op : la requête reste pendante et répondable (même
   * politique fail-closed que PermissionBroker.resolve default).
   */
  resolve(requestId: string, answers: Record<string, string> | undefined): void {
    const pending = this.requests.get(requestId)
    if (!pending) return

    if (answers === undefined) {
      this.requests.delete(requestId)
      pending.settle({ behavior: 'deny', message: "L'utilisateur a répondu directement dans le chat" })
      return
    }
    if (!isStringRecord(answers)) return

    this.requests.delete(requestId)
    pending.settle({ behavior: 'allow', updatedInput: { ...pending.input, answers } })
  }

  /** Requêtes en attente, plus anciennes d'abord — ré-émises à la (re)connexion. */
  pending(): QuestionRequest[] {
    return [...this.requests.values()].map((entry) => entry.request)
  }

  /** Deny tout (abort du tour, suppression de session). */
  abort(): void {
    for (const entry of this.requests.values()) {
      entry.settle({ behavior: 'deny', message: 'Session aborted' })
    }
    this.requests.clear()
  }
}

/** Valide et re-projette l'input SDK en QcmQuestion[] propre. null = malformé. */
function parseQuestions(input: unknown): QcmQuestion[] | null {
  if (typeof input !== 'object' || input === null) return null
  const questions = (input as Record<string, unknown>).questions
  if (!Array.isArray(questions) || questions.length === 0) return null

  const parsed: QcmQuestion[] = []
  for (const raw of questions) {
    if (typeof raw !== 'object' || raw === null) return null
    const { question, header, options, multiSelect } = raw as Record<string, unknown>
    if (typeof question !== 'string' || typeof header !== 'string') return null
    if (!Array.isArray(options) || options.length === 0) return null

    const parsedOptions: QcmOption[] = []
    for (const rawOption of options) {
      if (typeof rawOption !== 'object' || rawOption === null) return null
      const { label, description, preview } = rawOption as Record<string, unknown>
      if (typeof label !== 'string' || typeof description !== 'string') return null
      parsedOptions.push({ label, description, ...(typeof preview === 'string' ? { preview } : {}) })
    }
    parsed.push({ question, header, options: parsedOptions, multiSelect: multiSelect === true })
  }
  return parsed
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && Object.values(value).every((v) => typeof v === 'string')
}
```

- [ ] **Step 4 : Vérifier le vert** — Run: `bun test apps/server/src/stream/question-broker.test.ts` — Expected: PASS (8 tests).

- [ ] **Step 5 : Commit**

```bash
git add apps/server/src/stream/question-broker.ts apps/server/src/stream/question-broker.test.ts
git commit -m "feat(server): QuestionBroker — cycle de vie des QCM AskUserQuestion"
```

### Task 4 : Routage `SessionStream` + bypass sélectif

**Files:**
- Modify: `apps/server/src/stream/session-stream.ts`
- Modify: `apps/server/src/sdk/sdk-client.ts` (retirer `bypassPermissions` de `RunTurnParams` et `buildQueryOptions`)
- Modify: `apps/server/src/sdk/sdk-client.mock.ts` (si `bypassPermissions` y est référencé — vérifier par grep)
- Test: `apps/server/src/stream/session-stream.test.ts`, `apps/server/src/sdk/sdk-client.test.ts`

- [ ] **Step 1 : Inventorier les usages** — Run: `grep -rn "bypassPermissions" apps/server/src apps/web/src packages/` — noter chaque site. Les sites WEB (gate, settings) ne changent PAS : le mode `SessionPermissionMode` persisté garde sa valeur `'bypassPermissions'` ; seule son application SDK change. **Disposition des tests existants** : les deux tests « 1bis » de `session-stream.test.ts` (L63-87, `runTurn passes bypassPermissions…`) assertent `runTurnParams(sdk).bypassPermissions` — ils sont REMPLACÉS par les nouveaux tests d'auto-allow sélectif ci-dessous (les supprimer, leur intention est couverte).

- [ ] **Step 2 : Écrire les tests qui échouent** (dans `session-stream.test.ts`, avec le mock SDK existant — suivre les patterns du fichier : construire un stream, injecter un `canUseTool` capturé par le mock, envoyer des messages via `onMessage`) :

```ts
describe('routage QCM', () => {
  test('AskUserQuestion publie question_request (pas permission_request) et la réponse settle allow+answers', async () => {
    // 1. runTurn démarre, le mock capture canUseTool
    // 2. const result = canUseTool('AskUserQuestion', VALID_INPUT) — un question_request sort sur le sink
    // 3. onMessage('{"type":"question_response","requestId":"<id>","answers":{"Quelle approche ?":"A"}}')
    // 4. await result → { behavior: 'allow', updatedInput: {...VALID_INPUT, answers} }
  })

  test('bypassPermissions : tout est auto-allow SAUF AskUserQuestion', async () => {
    // permissionMode 'bypassPermissions' pour la session :
    // canUseTool('Bash', {command:'ls'}) → allow immédiat, AUCUN permission_request émis
    // canUseTool('AskUserQuestion', VALID_INPUT) → question_request émis (pendant)
  })

  test('bypassPermissions n’est plus transmis au SDK', () => {
    // assertion runtime (l'absence de type ne s'asserte pas) :
    // expect('bypassPermissions' in (runTurnParams(sdk) as object)).toBe(false)
  })

  test('onConnect ré-émet les question_request pendants', () => {
    // question pendante puis onConnect(sink2) → sink2 reçoit le question_request (+ le snapshot status)
  })

  test('abort deny les questions pendantes', async () => {
    // question pendante, onMessage('{"type":"abort"}') → la promesse settle en deny 'Session aborted'
  })

  test('dispose deny les questions pendantes', async () => { /* idem via dispose() */ })
})
```

Écrire ces tests en entier en suivant les helpers du fichier existant (`setup`, `makeSink`, `ofType`, `clientMessage`, `runTurnParams`, `tick`) — ils doivent être exécutables, pas des pseudo-tests.

- [ ] **Step 3 : Vérifier l'échec** — Run: `bun test apps/server/src/stream/session-stream.test.ts` — Expected: FAIL.

- [ ] **Step 4 : Implémenter** dans `session-stream.ts` :

1. Champ + constructeur (après la création du `PermissionBroker`) :

```ts
private readonly questions: QuestionBroker
// dans le constructor :
this.questions = new QuestionBroker((request) => {
  this.broadcast({ ...request, sessionId: this.sessionId() })
})
```

2. `runTurn` : remplacer le couple `canUseTool` + `bypassPermissions` par :

```ts
// Routage canUseTool (spec QCM) : le QCM va au QuestionBroker — jamais aux
// règles « always » ; le mode skip-permissions est un auto-allow sélectif
// (plus de bypassPermissions SDK : il court-circuitait canUseTool et avalait le QCM).
canUseTool: (toolName, input) => {
  if (toolName === 'AskUserQuestion') return this.questions.request(input)
  if (permissionMode === 'bypassPermissions') return Promise.resolve({ behavior: 'allow' as const })
  return this.broker.request(toolName, input)
},
signal: abort.signal,
```

3. `onMessage` : nouveau case :

```ts
case 'question_response':
  this.questions.resolve(message.requestId, message.answers)
  return
```

4. `onConnect` : après la boucle permissions :

```ts
for (const request of this.questions.pending()) send({ ...request, sessionId: this.sessionId() })
```

5. `abort` (case du switch) et `dispose()` : ajouter `this.questions.abort()` à côté de `this.broker.abort()`.

6. Dans `sdk-client.ts` : supprimer `bypassPermissions?: boolean` de `RunTurnParams` et la ligne `...(params.bypassPermissions === true ? {...} : {})` de `buildQueryOptions` ; adapter les tests de `sdk-client.test.ts` qui exerçaient cette branche (les supprimer) ; adapter `sdk-client.mock.ts` si besoin (Step 1).

- [ ] **Step 5 : Vérifier le vert** — Run: `bun test apps/server` — Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add apps/server/src/stream/session-stream.ts apps/server/src/stream/session-stream.test.ts apps/server/src/sdk/sdk-client.ts apps/server/src/sdk/sdk-client.test.ts apps/server/src/sdk/sdk-client.mock.ts
git commit -m "feat(server): routage QCM dans canUseTool + skip-permissions en auto-allow sélectif"
```

### Task 5 : Silence du flux outil + résumé historique

**Files:**
- Modify: `apps/server/src/stream/session-stream.ts` (`handleTurnEvent`)
- Modify: `apps/server/src/stream/describe-tool-use.ts`
- Test: `apps/server/src/stream/session-stream.test.ts`, `apps/server/src/stream/describe-tool-use.test.ts`

- [ ] **Step 1 : Tests qui échouent**

`describe-tool-use.test.ts` :

```ts
test('AskUserQuestion → résumé QCM avec les headers', () => {
  const input = { questions: [{ question: 'q1', header: 'Approche', options: [], multiSelect: false }, { question: 'q2', header: 'Scope', options: [], multiSelect: false }] }
  expect(describeToolUse('AskUserQuestion', input)).toEqual({ kind: 'Other', summary: 'QCM : Approche, Scope' })
})

test('AskUserQuestion input malformé → résumé générique', () => {
  expect(describeToolUse('AskUserQuestion', {})).toEqual({ kind: 'Other', summary: 'QCM' })
})
```

`session-stream.test.ts` :

```ts
test('tool_use/tool_result AskUserQuestion ne sont pas broadcastés (la carte QCM représente le tour)', async () => {
  // Faire émettre par le mock : tool_use {toolName:'AskUserQuestion', toolUseId:'t1'}, puis tool_result {toolUseId:'t1'},
  // puis tool_use Bash {toolUseId:'t2'} + tool_result t2.
  // Attendu : le sink ne voit NI tool_use t1 NI tool_result t1, mais voit bien t2 (les deux).
})

test('le reset de partialText au tool_use AskUserQuestion est conservé', async () => {
  // text_delta 'avant' puis tool_use AskUserQuestion → un onConnect(sink2) reçoit un snapshot streaming SANS partialText 'avant'.
  // ⚠️ Pour observer un snapshot 'streaming', le tour doit rester ouvert : faire suivre
  // le tool_use d'un needs_permission bloquant — décalquer le test existant L254-297
  // (quasi identique), sinon le turn_done settle avant l'onConnect.
})
```

Écrire ces deux tests en entier (mêmes helpers que Task 4) — exécutables, pas des pseudo-tests.

- [ ] **Step 2 : Vérifier l'échec** — Run: `bun test apps/server/src/stream` — Expected: FAIL.

- [ ] **Step 3 : Implémenter**

`describe-tool-use.ts` — avant le `return { kind: ToolKinds.Other, ... }` final :

```ts
if (toolName === 'AskUserQuestion') {
  const questions = Array.isArray(record.questions) ? record.questions : []
  const headers = questions.map((q) => str(asRecord(q).header)).filter((h) => h !== '')
  return { kind: ToolKinds.Other, summary: truncate(headers.length > 0 ? `QCM : ${headers.join(', ')}` : 'QCM') }
}
```

`session-stream.ts` — champ `private readonly suppressedToolUseIds = new Set<string>()` (le vider en début de `runTurn`, à côté de `this.partialText = ''` — un tool_use avorté sans tool_result ne doit pas s'accumuler), puis dans `handleTurnEvent` :

```ts
case 'tool_use':
  // Un tool_use clôt le run de texte courant — le buffer ne suit que le run en cours.
  // Ce reset reste MÊME quand le broadcast est supprimé (QCM) : sinon le snapshot
  // de reconnexion re-servirait le texte pré-QCM comme run en cours.
  this.partialText = ''
  if (event.toolName === 'AskUserQuestion') {
    // La carte QCM est la représentation du tour — une ligne outil doublonnerait.
    this.suppressedToolUseIds.add(event.toolUseId)
    return
  }
  this.broadcast({ /* … broadcast existant inchangé … */ })
  return
case 'tool_result':
  if (this.suppressedToolUseIds.delete(event.toolUseId)) return
  this.broadcast({ /* … broadcast existant inchangé … */ })
  return
```

- [ ] **Step 4 : Vérifier le vert** — Run: `bun test apps/server` — Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add apps/server/src/stream/session-stream.ts apps/server/src/stream/session-stream.test.ts apps/server/src/stream/describe-tool-use.ts apps/server/src/stream/describe-tool-use.test.ts
git commit -m "feat(server): silence du flux outil AskUserQuestion + résumé QCM en historique"
```

---

## Chunk 2 : état web (reducer, contrôleur, fixture)

### Task 6 : `stream-reducer` — item `question`

**Files:**
- Modify: `apps/web/src/state/stream-reducer.ts`
- Test: `apps/web/src/state/stream-reducer.test.ts`

- [ ] **Step 1 : Tests qui échouent** (suivre les patterns du fichier existant) :

```ts
const QUESTION_EVENT = {
  type: 'question_request' as const,
  sessionId: 's1',
  requestId: 'q1',
  questions: [{ question: 'Quelle approche ?', header: 'Approche', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }],
}

test('question_request insère un item question et clôt le run de texte', () => {
  let state = reduce(initialState(), { type: 'assistant_delta', sessionId: 's1', text: 'hmm' })
  state = reduce(state, QUESTION_EVENT)
  expect(state.items.at(-1)).toMatchObject({ kind: 'question', requestId: 'q1' })
  expect(state.items.at(-2)).toMatchObject({ kind: 'assistant', streaming: false })
  expect(state.status).toBe('streaming')
})

test('question_request est dédupliqué par requestId (ré-émission reconnexion)', () => {
  let state = reduce(initialState(), QUESTION_EVENT)
  state = reduce(state, QUESTION_EVENT)
  expect(state.items).toHaveLength(1)
})

test('resolveQuestion marque answered avec les réponses', () => {
  const state = resolveQuestion(reduce(initialState(), QUESTION_EVENT), 'q1', { 'Quelle approche ?': 'A' })
  expect(state.items[0]).toMatchObject({ kind: 'question', resolved: 'answered', answers: { 'Quelle approche ?': 'A' } })
})

test('resolveQuestion sans answers marque dismissed', () => {
  const state = resolveQuestion(reduce(initialState(), QUESTION_EVENT), 'q1', undefined)
  expect(state.items[0]).toMatchObject({ kind: 'question', resolved: 'dismissed' })
})
```

- [ ] **Step 2 : Vérifier l'échec** — Run: `bun test apps/web/src/state/stream-reducer.test.ts` — Expected: FAIL.

- [ ] **Step 3 : Implémenter**

1. `ChatItem` gagne la variante :

```ts
  | {
      kind: 'question'
      requestId: string
      questions: QcmQuestion[]
      resolved?: 'answered' | 'dismissed'
      answers?: Record<string, string>
    }
```

(import `QcmQuestion` depuis `@atelier/shared`.)

2. `reduce` : `case 'question_request': return applyQuestionRequest(state, event)` :

```ts
function applyQuestionRequest(state: StreamState, event: Extract<ServerEvent, { type: 'question_request' }>): StreamState {
  // Ré-émission à chaque reconnexion — dédup par requestId (même règle que les permissions).
  if (state.items.some((item) => item.kind === 'question' && item.requestId === event.requestId)) return state
  const items = closeTextRun(state.items)
  items.push({ kind: 'question', requestId: event.requestId, questions: event.questions })
  return { ...state, status: 'streaming', items }
}
```

3. Helper exporté (miroir de `resolvePermission`) :

```ts
/** Résolution locale (optimiste) — la résolution définitive est serveur-side. answers absent = dismiss. */
export function resolveQuestion(state: StreamState, requestId: string, answers: Record<string, string> | undefined): StreamState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === 'question' && item.requestId === requestId
        ? { ...item, resolved: answers !== undefined ? ('answered' as const) : ('dismissed' as const), answers }
        : item,
    ),
  }
}
```

- [ ] **Step 4 : Vérifier le vert** — Run: `bun test apps/web/src/state` — Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add apps/web/src/state/stream-reducer.ts apps/web/src/state/stream-reducer.test.ts
git commit -m "feat(web): item question dans le stream-reducer (dedup, resolveQuestion)"
```

### Task 7 : `session-controller` — `answerQuestion` + dismiss au `sendMessage`

**Files:**
- Modify: `apps/web/src/state/session-controller.ts`
- Test: `apps/web/src/state/session-controller.test.ts`

- [ ] **Step 1 : Tests qui échouent** (utiliser le `ControllerSocket` factice du fichier existant, qui capture les `send`) :

Écrire ces tests en entier (harnais `FakeControllerSocket` + tableau `sent` existants) — exécutables, pas des pseudo-tests.

```ts
test('answerQuestion envoie question_response et fige l’item', async () => {
  // open() sur un socket factice ; injecter un question_request via le handler capturé ;
  controller.answerQuestion('q1', { 'Quelle approche ?': 'A' })
  // sent contient { type: 'question_response', requestId: 'q1', answers: {...} }
  // getState().items → l'item question a resolved:'answered'
})

test('sendMessage pendant un QCM pendant : dismiss d’abord, message en file ensuite', async () => {
  // question_request q1 pendant (status streaming — le QCM arrive mid-turn)
  controller.sendMessage('réponse libre')
  // ordre des sends : {type:'question_response', requestId:'q1'} (SANS answers) AVANT tout user_message
  // l'item q1 → resolved:'dismissed' ; l'item user est queued:true (le tour n'est pas idle)
  // puis événement status idle → le user_message part (pump)
})

test('sendMessage sans QCM pendant : comportement inchangé', async () => { /* non-régression : aucun question_response émis */ })
```

- [ ] **Step 2 : Vérifier l'échec** — Run: `bun test apps/web/src/state/session-controller.test.ts` — Expected: FAIL.

- [ ] **Step 3 : Implémenter**

```ts
import { initialState, reduce, reset, resolvePermission, resolveQuestion, type StreamState } from './stream-reducer'

answerQuestion(requestId: string, answers: Record<string, string>): void {
  if (this.socket === null) return
  this.socket.send({ type: 'question_response', requestId, answers })
  this.setState(resolveQuestion(this.state, requestId, answers))
}
```

Dans `sendMessage`, juste après le garde `if (this.socket === null || this.resyncing) return false` :

```ts
// Taper un message pendant un QCM = y répondre en texte : dismiss d'abord
// (le deny dénoue le tour côté serveur), le message part au prochain idle.
this.dismissPendingQuestions()
```

```ts
private dismissPendingQuestions(): void {
  let state = this.state
  for (const item of this.state.items) {
    if (item.kind === 'question' && item.resolved === undefined) {
      this.socket?.send({ type: 'question_response', requestId: item.requestId })
      state = resolveQuestion(state, item.requestId, undefined)
    }
  }
  if (state !== this.state) this.setState(state)
}
```

- [ ] **Step 4 : Vérifier le vert** — Run: `bun test apps/web/src/state` — Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add apps/web/src/state/session-controller.ts apps/web/src/state/session-controller.test.ts
git commit -m "feat(web): answerQuestion + dismiss des QCM pendants au sendMessage"
```

### Task 8 : Fixture QCM (dev sans SDK)

**Files:**
- Modify: `apps/web/src/state/fixtures.ts` (constante `fixtureTurn`, L87 — c'est ICI qu'elle vit, `backend.ts` ne fait que l'importer)
- Modify: `apps/web/src/api/backend.ts` (uniquement : étendre le commentaire `permission_response` L173 pour mentionner `question_response`)

- [ ] **Step 1 : Localiser `fixtureTurn`** — Run: `grep -n "fixtureTurn" apps/web/src/state/fixtures.ts apps/web/src/api/backend.ts` — le script d'événements (typé `ServerEvent[]`, chaque entrée porte `sessionId: FIXTURE_SESSION_ID`) est rejoué à chaque `user_message` en mode `VITE_USE_FIXTURES`.

- [ ] **Step 2 : Ajouter l'événement** dans `fixtures.ts`, avant le `status: idle` final du script (le `sessionId` est OBLIGATOIRE — le type de la variante est `QuestionRequest & { sessionId: string }`, et `session-controller.test.ts:474` émet les entrées telles quelles, sans réinjection) :

```ts
{
  type: 'question_request',
  sessionId: FIXTURE_SESSION_ID,
  requestId: 'fixture-q-1',
  questions: [
    {
      question: 'Quelle approche préfères-tu ?',
      header: 'Approche',
      options: [
        { label: 'Broker dédié', description: 'Un QuestionBroker séparé, sémantique claire' },
        { label: 'Étendre le broker', description: 'Moins de fichiers, plus de gardes' },
      ],
      multiSelect: false,
    },
    {
      question: 'Quelles plateformes cibler ?',
      header: 'Plateformes',
      options: [
        { label: 'macOS', description: 'Le daily driver' },
        { label: 'Linux', description: 'Un jour peut-être' },
        { label: 'Windows', description: 'Non prioritaire' },
      ],
      multiSelect: true,
    },
  ],
},
```

Note : `FixtureSocket.send` (backend.ts) ignore déjà tout sauf `user_message`/`abort` — un `question_response` est résolu localement par le contrôleur, rien à ajouter côté socket (même politique que le commentaire `permission_response` existant L173 ; étendre ce commentaire pour mentionner `question_response`).

- [ ] **Step 3 : Vérifier** — Run: `bun test apps/web` — Expected: PASS (le seul test qui itère `fixtureTurn`, `session-controller.test.ts:468-482`, fait des assertions `some()` + idle final — il reste vert avec l'événement ajouté).

- [ ] **Step 4 : Commit**

```bash
git add apps/web/src/state/fixtures.ts apps/web/src/api/backend.ts
git commit -m "feat(web): QCM dans le tour fixture (démo/dev sans SDK)"
```

---

## Chunk 3 : UI (carte QCM, câblage, vérification réelle)

### Task 9 : Composant `QuestionPrompt`

**Files:**
- Create: `apps/web/src/components/QuestionPrompt.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/components/QuestionPrompt.test.tsx`

- [ ] **Step 1 : Tests qui échouent** (mêmes conventions que `PermissionPrompt.test.tsx` : flag `IS_REACT_ACT_ENVIRONMENT`, `afterEach(cleanup)` ; les items de test sont les constantes `MONO`/`MULTI` ci-dessous) :

```tsx
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QuestionPrompt, type QuestionChatItem } from './QuestionPrompt'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const MONO: QuestionChatItem = {
  kind: 'question',
  requestId: 'q1',
  questions: [
    {
      question: 'Quelle approche ?',
      header: 'Approche',
      options: [
        { label: 'A', description: 'la première' },
        { label: 'B', description: 'la seconde' },
      ],
      multiSelect: false,
    },
  ],
}

const MULTI: QuestionChatItem = {
  ...MONO,
  questions: [
    MONO.questions[0],
    { question: 'Quelles plateformes ?', header: 'Plateformes', options: [{ label: 'macOS', description: 'm' }, { label: 'Linux', description: 'l' }], multiSelect: true },
  ],
}

describe('QuestionPrompt', () => {
  test('rend chip, question, labels et descriptions', () => {
    render(<QuestionPrompt item={MONO} onAnswer={mock()} />)
    expect(screen.getByText('Approche')).toBeTruthy()
    expect(screen.getByText('Quelle approche ?')).toBeTruthy()
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('la première')).toBeTruthy()
  })

  test('mono-question single-select : le clic sur une option envoie directement', () => {
    const onAnswer = mock()
    render(<QuestionPrompt item={MONO} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: /la première/ }))
    expect(onAnswer).toHaveBeenCalledWith({ 'Quelle approche ?': 'A' })
  })

  test('mono-question : « Autre » ouvre le champ, l’envoi passe par le bouton', () => {
    const onAnswer = mock()
    render(<QuestionPrompt item={MONO} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: /Autre/ }))
    expect(onAnswer).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ma réponse' } })
    fireEvent.click(screen.getByRole('button', { name: /Envoyer/ }))
    expect(onAnswer).toHaveBeenCalledWith({ 'Quelle approche ?': 'ma réponse' })
  })

  test('multi-questions : bouton Envoyer inactif tant que tout n’est pas répondu', () => {
    const onAnswer = mock()
    render(<QuestionPrompt item={MULTI} onAnswer={onAnswer} />)
    const submit = screen.getByRole('button', { name: /Envoyer/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /la première/ }))
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /macOS/ }))
    fireEvent.click(screen.getByRole('button', { name: /Linux/ }))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledWith({ 'Quelle approche ?': 'A', 'Quelles plateformes ?': 'macOS, Linux' })
  })

  test('multiSelect : re-cliquer désélectionne', () => {
    render(<QuestionPrompt item={MULTI} onAnswer={mock()} />)
    const macos = screen.getByRole('button', { name: /macOS/ })
    fireEvent.click(macos)
    expect(macos.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(macos)
    expect(macos.getAttribute('aria-pressed')).toBe('false')
  })

  test('résolu answered : options figées, réponse mise en évidence', () => {
    render(<QuestionPrompt item={{ ...MONO, resolved: 'answered', answers: { 'Quelle approche ?': 'A' } }} onAnswer={mock()} />)
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Répondu')).toBeTruthy()
  })

  test('résolu dismissed : mention « Répondu dans le chat »', () => {
    render(<QuestionPrompt item={{ ...MONO, resolved: 'dismissed' }} onAnswer={mock()} />)
    expect(screen.getByText('Répondu dans le chat')).toBeTruthy()
  })

  test('a11y : role alert pendant pending seulement', () => {
    const { rerender } = render(<QuestionPrompt item={MONO} onAnswer={mock()} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    rerender(<QuestionPrompt item={{ ...MONO, resolved: 'dismissed' }} onAnswer={mock()} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
```

- [ ] **Step 2 : Vérifier l'échec** — Run: `bun test apps/web/src/components/QuestionPrompt.test.tsx` — Expected: FAIL (module inexistant).

- [ ] **Step 3 : Implémenter** — `apps/web/src/components/QuestionPrompt.tsx` :

```tsx
import { useRef, useState } from 'react'
import type { QcmQuestion } from '@atelier/shared'
import type { ChatItem } from '../state/stream-reducer'

export type QuestionChatItem = Extract<ChatItem, { kind: 'question' }>

export type QuestionPromptProps = {
  item: QuestionChatItem
  onAnswer: (answers: Record<string, string>) => void
}

/** Sélections en cours, par texte de question. useOther bascule sur le champ libre. */
type Draft = { selected: string[]; other: string; useOther: boolean }

const EMPTY_DRAFT: Draft = { selected: [], other: '', useOther: false }

/**
 * Carte QCM inline non-modale (spec 2026-07-31-ask-user-question-qcm) — même
 * patron a11y que PermissionPrompt : live region role="alert" pendant pending,
 * focus parqué sur la carte avant désactivation, carte figée une fois résolue.
 * PAS d'ambre (réservé aux permissions) : accent standard.
 *
 * Mono-question single-select : cliquer une option prédéfinie envoie
 * directement (friction zéro). « Autre » et tous les autres cas passent par le
 * bouton « Envoyer les réponses », actif quand chaque question a une réponse.
 */
export function QuestionPrompt({ item, onAnswer }: QuestionPromptProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const resolved = item.resolved
  const disabled = resolved !== undefined
  const directSend = item.questions.length === 1 && !item.questions[0].multiSelect

  const draftOf = (q: QcmQuestion): Draft => drafts[q.question] ?? EMPTY_DRAFT
  const setDraft = (q: QcmQuestion, patch: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [q.question]: { ...draftOf(q), ...patch } }))
  }
  const answerOf = (q: QcmQuestion): string | null => {
    const draft = draftOf(q)
    if (draft.useOther) return draft.other.trim() === '' ? null : draft.other.trim()
    // Contrat SDK : multi-select joint par virgule.
    return draft.selected.length > 0 ? draft.selected.join(', ') : null
  }
  const complete = item.questions.every((q) => answerOf(q) !== null)

  const send = (answers: Record<string, string>) => {
    // Les boutons vont se désactiver — parquer le focus sur la carte d'abord.
    cardRef.current?.focus()
    onAnswer(answers)
  }
  const submit = () => {
    const answers: Record<string, string> = {}
    for (const q of item.questions) {
      const answer = answerOf(q)
      if (answer === null) return
      answers[q.question] = answer
    }
    send(answers)
  }
  const pick = (q: QcmQuestion, label: string) => {
    if (directSend) {
      send({ [q.question]: label })
      return
    }
    const draft = draftOf(q)
    const selected = q.multiSelect
      ? draft.selected.includes(label)
        ? draft.selected.filter((l) => l !== label)
        : [...draft.selected, label]
      : [label]
    setDraft(q, { selected, useOther: false })
  }

  return (
    <div ref={cardRef} tabIndex={-1} className="question" role="group" aria-label="Question de Claude">
      <div role={disabled ? undefined : 'alert'}>
        <div className="q-head">
          <span className="k">Question</span> Claude a besoin de ton avis :
        </div>
      </div>
      {item.questions.map((q) => {
        const draft = draftOf(q)
        const chosen = item.answers?.[q.question]
        return (
          <fieldset key={q.question} className="q-block" disabled={disabled}>
            <div className="q-chip">{q.header}</div>
            <div className="q-text">{q.question}</div>
            <div className="q-options">
              {q.options.map((option) => {
                const active = resolved === 'answered' ? chosen !== undefined && splitChoices(chosen).includes(option.label) : draft.selected.includes(option.label)
                return (
                  <button
                    key={option.label}
                    type="button"
                    className={active ? 'q-option active' : 'q-option'}
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => pick(q, option.label)}
                  >
                    <span className="q-label">{option.label}</span>
                    <span className="q-desc">{option.description}</span>
                    {option.preview !== undefined && active && <code className="q-preview">{option.preview}</code>}
                  </button>
                )
              })}
              <button
                type="button"
                className={draft.useOther ? 'q-option active' : 'q-option'}
                aria-pressed={draft.useOther}
                disabled={disabled}
                onClick={() => setDraft(q, { useOther: !draft.useOther, selected: [] })}
              >
                <span className="q-label">Autre…</span>
                <span className="q-desc">Réponse libre</span>
              </button>
            </div>
            {draft.useOther && !disabled && (
              <input
                type="text"
                className="q-other"
                placeholder="Ta réponse…"
                value={draft.other}
                onChange={(e) => setDraft(q, { other: e.target.value })}
              />
            )}
          </fieldset>
        )
      })}
      {!disabled && !(directSend && !draftOf(item.questions[0]).useOther) && (
        <div className="q-actions">
          <button type="button" className="q-submit" disabled={!complete} onClick={submit}>
            Envoyer les réponses
          </button>
        </div>
      )}
      {resolved === 'answered' && <div className="q-outcome">Répondu</div>}
      {resolved === 'dismissed' && <div className="q-outcome">Répondu dans le chat</div>}
    </div>
  )
}

/** Une réponse multi-select persistée est jointe par virgule — la re-splitter pour surligner. */
function splitChoices(answer: string): string[] {
  return answer.split(',').map((part) => part.trim())
}
```

- [ ] **Step 4 : Styles** — dans `apps/web/src/styles.css`, à côté du bloc `.permission` (L288-299), ajouter un bloc `.question` : même gabarit de carte (bordure, padding, radius) mais **accent standard** (var d'accent du thème — PAS l'ambre, réservé aux permissions ; les styles `.allow` existants sont scopés `.permission .p-actions .allow` et ne s'appliqueraient de toute façon pas ici). Classes : `.q-head`, `.q-chip` (petit tag), `.q-block`, `.q-options` (pile verticale), `.q-option` (bouton pleine largeur, `.q-label` gras + `.q-desc` atténué), `.q-option.active` (bordure accent), `.q-preview` (bloc code), `.q-other` (input pleine largeur), `.q-actions` + `.q-submit` (bouton d'envoi, accent), `.q-outcome`. Respecter les variables de thème existantes (charte v5, dark + light).

Choix assumés (divergences volontaires vs spec, cosmétiques) : le `preview` est rendu sous l'option **sélectionnée** uniquement (pas au survol — plus simple, testable) ; les options sont des toggle-buttons `aria-pressed` plutôt que des radios/checkboxes natifs (cohérent avec les cartes boutons du reste de l'app).

- [ ] **Step 5 : Vérifier le vert** — Run: `bun test apps/web/src/components/QuestionPrompt.test.tsx` — Expected: PASS (9 tests).

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src/components/QuestionPrompt.tsx apps/web/src/components/QuestionPrompt.test.tsx apps/web/src/styles.css
git commit -m "feat(web): carte QuestionPrompt — options, multiSelect, Autre, a11y"
```

### Task 10 : Câblage ChatView + App

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/components/ChatView.test.tsx`, `apps/web/src/App.test.tsx`

- [ ] **Step 1 : Tests qui échouent**

`ChatView.test.tsx` (suivre les helpers existants — écrire ces tests en entier, exécutables, pas des pseudo-tests) :

```ts
test('rend une carte question et remonte la réponse', () => { /* item kind question → QuestionPrompt visible ; clic option → onQuestionAnswer(requestId, answers) */ })
test('un QCM pendant masque le typing indicator', () => { /* status streaming + dernier item question non résolu → pas de TypingIndicator */ })
```

`App.test.tsx` : un test de bout en bout via le fixture (le tour fixture contient désormais un QCM — Task 8) : envoyer un message, attendre la carte, cliquer une option de la première question + une de la seconde + Envoyer, vérifier que la carte passe à « Répondu ».

- [ ] **Step 2 : Vérifier l'échec** — Run: `bun test apps/web/src/components/ChatView.test.tsx apps/web/src/App.test.tsx` — Expected: FAIL.

- [ ] **Step 3 : Implémenter**

`ChatView.tsx` :

1. Props : `onQuestionAnswer: (requestId: string, answers: Record<string, string>) => void`. ⚠️ Prop REQUISE → mettre à jour les appels `render(<ChatView …/>)` existants du helper `setup()` de `ChatView.test.tsx` (tests d'auto-scroll) qui ne la passent pas — rien ne typecheck dans la CI (`bun test` transpile sans vérifier), une omission laisserait des erreurs TS silencieuses.
2. `Block` gagne `| { type: 'question'; item: QuestionChatItem }` ; `toBlocks` : `case 'question': blocks.push({ type: 'question', item })`.
3. Typing indicator — étendre la condition :

```ts
const showTyping =
  status === 'streaming' &&
  !(last?.kind === 'assistant' && last.streaming) &&
  !(last?.kind === 'permission' && last.resolved === undefined) &&
  !(last?.kind === 'question' && last.resolved === undefined)
```

4. Rendu :

```tsx
case 'question': {
  const { item } = block
  return <QuestionPrompt key={item.requestId} item={item} onAnswer={(answers) => onQuestionAnswer(item.requestId, answers)} />
}
```

`App.tsx` : repérer le rendu de `<ChatView … onPermissionDecision={…} />` et passer à côté :

```tsx
onQuestionAnswer={(requestId, answers) => controller.answerQuestion(requestId, answers)}
```

(adapter au nom réel de l'instance contrôleur dans App.tsx — vérifier comment `respondPermission` y est appelé et suivre le même pattern).

- [ ] **Step 4 : Vérifier le vert** — Run: `bun test apps/web` puis `bun test` (suite complète) — Expected: PASS partout.

- [ ] **Step 5 : Commit**

```bash
git add apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): câblage QCM — ChatView + answerQuestion depuis App"
```

### Task 11 : Vérification réelle (gate obligatoire — spec « Risque principal »)

**Files:** aucun (vérification manuelle) — éventuels correctifs selon constats.

⚠️ Ne PAS toucher au serveur port 4517 (l'app Atelier de Germain tourne dessus). Utiliser `ATELIER_PORT=4519`.

- [ ] **Step 1 : Lancer l'app en dev** — Run: `bun run build:web && ATELIER_PORT=4519 bun run --cwd apps/desktop dev` (ou le flux `ATELIER_DEV=1` + `dev:server`/`dev:web` documenté dans le README/memory).

- [ ] **Step 2 : QCM en mode normal** — nouvelle session, permissions normales, prompt : « Pose-moi une question à choix multiples avec l'outil AskUserQuestion pour choisir entre trois couleurs. » — Attendu : la carte QCM s'affiche, cliquer une option envoie, Claude reçoit la réponse et la reformule dans le tour.

- [ ] **Step 3 : Équivalence skip-permissions** — nouvelle session AVEC skip permissions : demander un tour exerçant Bash + Edit + Write (ex. « crée un fichier /tmp/qcm-test.txt, modifie-le, liste /tmp ») — Attendu : AUCUN prompt de permission, aucune régression observable. Puis un QCM dans la même session — Attendu : la carte remonte et fonctionne.

- [ ] **Step 4 : Réponse en texte** — déclencher un QCM, taper un message dans le composer au lieu de cliquer — Attendu : carte « Répondu dans le chat », le message part après le settle, Claude en tient compte.

- [ ] **Step 5 : Séparateur multi-select** — déclencher un QCM multiSelect, choisir 2 options, vérifier dans le tour que Claude restitue bien les deux choix (valide le join par virgule).

- [ ] **Step 6 : En cas de divergence bloquante au Step 3** — appliquer le repli documenté dans la spec (conserver le mode SDK `bypassPermissions` en skip-permissions ; QCM inopérant dans ces sessions uniquement) et le noter dans le commit + la spec.

- [ ] **Step 7 : Release** — bumper `version.json` (version + notes FR concises, ex. « Les questions à choix multiples de Claude sont maintenant répondables d'un clic ») puis `bun run build:web`. Commit :

```bash
git add version.json
git commit -m "release: QCM natif AskUserQuestion"
```
