# Session Deletion from the UI — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete any conversation (real SDK session or draft) from the sidebar, with a confirmation dialog for real sessions — real deletion via the SDK (`.jsonl` removed, CLI included).

**Architecture:** The existing `DELETE /api/sessions/:id` route becomes a unified entry point: `SessionsService.delete(id)` disposes the live stream (new `SessionStreamRegistry.dispose`), removes the draft record or calls the SDK's `deleteSession`, and cleans `AppData`. The web side extends the existing `.del` × button to every session and gates real sessions behind a new `DeleteSessionDialog`. Spec: `docs/specs/2026-07-17-session-delete-design.md` (normative — re-read it before starting).

**Tech Stack:** Bun monorepo · Hono (apps/server) · Claude Agent SDK 0.3.198 · React 19 + React Query + Radix Dialog (apps/web) · `bun test` (bun:test + Testing Library).

**Conventions (read once):**
- TDD per task: failing test → minimal code → green → commit. Run `bun test <file>` for the task's file, and the FULL `bun test` before each commit (baseline: 324 tests green as of 0cfd48b — all must stay green).
- `bun test` does NOT typecheck. Interface changes surface at runtime through tests — which is why constructor/interface changes and their call-site updates land in the same task.
- All user-facing strings are French. Code comments explain WHY, in English, matching the existing voice.
- Do not start any server; tests never bind port 4517. (See memory note: never kill a process on 4517 without identifying its owner.)

---

## Chunk 1: Server — SDK client, stream dispose, service delete, route

### Task 1: `SdkClient.deleteSession` (interface + real + mock)

**Files:**
- Modify: `apps/server/src/sdk/sdk-client.ts` (interface l.43-48, AgentSdkClient methods near l.70)
- Modify: `apps/server/src/sdk/sdk-client.mock.ts`

Pure plumbing — the thin wrapper has no logic to unit-test on its own; Task 3's service tests exercise the mock, and the real client follows the exact `renameSession` wrapper pattern. No dedicated test here.

- [ ] **Step 1: Add `deleteSession` to the `SdkClient` interface**

In `apps/server/src/sdk/sdk-client.ts`, extend the interface:

```ts
export interface SdkClient {
  listSessions(cwd: string): Promise<SdkSessionInfo[]>
  getSessionMessages(sessionId: string): Promise<ChatMessage[]>
  renameSession(sessionId: string, name: string): Promise<void>
  deleteSession(sessionId: string, dir: string): Promise<void>
  runTurn(params: RunTurnParams): AsyncIterable<SdkTurnEvent>
}
```

- [ ] **Step 2: Implement in `AgentSdkClient`**

Add `deleteSession` to the SDK import list at the top of the file (alongside `renameSession`):

```ts
import {
  deleteSession,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  type SDKMessage,
  type SDKRateLimitEvent,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
```

Add the method right after `renameSession` (same pattern — the unqualified name inside the method resolves to the module import, exactly like `renameSession` does):

```ts
/**
 * SDK: deleteSession(sessionId, { dir }) → Promise<void> — removes
 * {sessionId}.jsonl and the {sessionId}/ subagent-transcript subdirectory;
 * throws if the session is not found. dir pins the project directory (same
 * semantics as listSessions({ dir })) so no cross-project search happens.
 */
async deleteSession(sessionId: string, dir: string): Promise<void> {
  await deleteSession(sessionId, { dir })
}
```

- [ ] **Step 3: Implement in `MockSdkClient`**

In `apps/server/src/sdk/sdk-client.mock.ts`, after `renameSession`:

```ts
async deleteSession(sessionId: string, dir: string): Promise<void> {
  this.calls.push({ method: 'deleteSession', args: [sessionId, dir] })
}
```

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: all green (no behavior changed).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sdk/sdk-client.ts apps/server/src/sdk/sdk-client.mock.ts
git commit -m "feat(server): SdkClient.deleteSession — interface, real client, mock"
```

### Task 2: `SessionStream.dispose()` + `SessionStreamRegistry.dispose(id)`

**Files:**
- Modify: `apps/server/src/stream/session-stream.ts`
- Test: `apps/server/src/stream/session-stream.test.ts`

**Why:** the registry caches one stream per session forever; without a removal method the in-memory singleton outlives the deleted `.jsonl` and a reconnection would resurrect a ghost session. Dispose = abort the in-flight turn (same path as the WS `abort` message) + drop sinks + remove the map entry. Server-side socket closing is deliberately NOT part of dispose (streams are socket-free by design; the single Electron window closes its own socket client-side).

- [ ] **Step 1: Write the failing tests**

Append to the `describe('SessionStream', ...)` block in `session-stream.test.ts` (reuse the existing `setup`, `makeSink`, `clientMessage`, `runTurnParams`, `tick` helpers and the `Draft` import):

```ts
// 8. Dispose — session deletion (spec 2026-07-17)
test('registry.dispose aborts the in-flight turn, drops sinks, and removes the entry', async () => {
  const { registry, sdk } = setup({
    turns: [[
      { type: 'text_delta', text: 'a' },
      // Holds the turn open (like the real SDK awaiting canUseTool) so dispose
      // catches it genuinely mid-turn.
      { type: 'needs_permission', toolName: 'Bash', input: { command: 'sleep 999' } },
      { type: 'text_delta', text: 'b' },
      { type: 'turn_done' },
    ]],
  })
  const stream = registry.get('s1', 'p1')
  const { events, send } = makeSink()
  stream.onConnect(send)

  stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
  await tick()
  const countAtDispose = events.length

  registry.dispose('s1')
  await tick()

  // the turn's signal was aborted — same path as the 'abort' client message
  expect(runTurnParams(sdk).signal.aborted).toBe(true)
  // sinks dropped: NOTHING further reached the sink, not even the idle settle
  expect(events.length).toBe(countAtDispose)
  // the entry is gone: a later get() builds a FRESH stream
  expect(registry.get('s1', 'p1')).not.toBe(stream)
})

test('registry.dispose of an unknown id is a no-op', () => {
  const { registry } = setup()
  expect(() => registry.dispose('ghost')).not.toThrow()
})

test('registry.dispose accepts the draft id after materialization re-keyed the stream', async () => {
  const draft: Draft = { id: 'd1', projectId: 'p1', name: null, model: 'claude-fable-5', createdAt: new Date().toISOString() }
  const { registry } = setup({
    draft,
    turns: [[{ type: 'session_started', sessionId: 'sdk-1' }, { type: 'turn_done' }]],
  })
  const stream = registry.get('d1', 'p1')
  stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
  await tick()
  // materialized: both ids resolve to the same singleton (existing invariant)
  expect(registry.get('sdk-1', 'p1')).toBe(stream)

  registry.dispose('d1') // the draft id resolves through draftMap

  expect(registry.get('sdk-1', 'p1')).not.toBe(stream)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/src/stream/session-stream.test.ts`
Expected: FAIL — `registry.dispose is not a function`.

- [ ] **Step 3: Implement dispose**

In `session-stream.ts`, add to `SessionStream` (after `onClose`):

```ts
/**
 * Deletion teardown (spec 2026-07-17): abort the in-flight turn — the same
 * path the 'abort' client message takes — then drop every sink so no further
 * event leaves this stream. Sockets are NOT closed here: the stream is
 * socket-free by design, and the single client (one Electron window) closes
 * its own socket; an orphaned socket is cleaned up by its onClose.
 */
dispose(): void {
  this.turnAbort?.abort()
  this.broker.abort()
  this.sinks.clear()
}
```

Add to `SessionStreamRegistry` (after `get`):

```ts
/**
 * Removes a session's singleton before its on-disk deletion — without this the
 * cached stream outlives the deleted JSONL and a reconnect would resurrect a
 * ghost session. Idempotent; resolves draft ids like get() does.
 */
dispose(id: string): void {
  const key = this.data.resolveSessionId(id)
  const stream = this.streams.get(key)
  if (!stream) return
  stream.dispose()
  this.streams.delete(key)
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test apps/server/src/stream/session-stream.test.ts` then full `bun test`
Expected: PASS, everything green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/stream/session-stream.ts apps/server/src/stream/session-stream.test.ts
git commit -m "feat(server): SessionStream/Registry dispose — abort turn, drop sinks, evict entry"
```

### Task 3: `SessionsService.delete` + `SessionNotFoundError` + registry injection

**Files:**
- Modify: `apps/server/src/sessions/sessions-service.ts`
- Modify: `apps/server/src/index.ts` (composition root)
- Modify: `apps/server/src/app.ts` (createApp accepts the registry instead of building it)
- Modify: `apps/server/src/app.test.ts:10-16` (freshApp)
- Modify: `apps/server/src/ide/open-in-ide.test.ts:139,240` (SessionsService constructions)
- Test: `apps/server/src/sessions/sessions-service.test.ts`

**Wiring note (from the spec):** the registry is currently constructed inside `createApp` — the service needs it, so construction moves to the composition root and is injected into both. `deleteDraft` stays in place this task (the route still calls it); Task 4 rewires the route and removes it.

- [ ] **Step 1: Update `freshSetup` and write the failing tests**

In `sessions-service.test.ts`, replace `freshSetup` (registry + optional scripted turns) and add the imports — NOTE: `SessionsService` is already imported from `./sessions-service`; MERGE `SessionNotFoundError` into that existing import line (a duplicate import binding is a SyntaxError under Bun):

```ts
import { SessionStreamRegistry } from '../stream/session-stream'
import { SessionNotFoundError, SessionsService } from './sessions-service'

type Turns = NonNullable<ConstructorParameters<typeof MockSdkClient>[0]>['turns']

function freshSetup(sessions: SdkSessionInfo[] = [], turns?: Turns) {
  const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-sessions-')), 'data.json')
  const data = new AppData(filePath)
  data.update((d) => {
    d.projects.push({ id: 'p1', path: '/tmp/x', color: 'cyan' })
  })
  const sdk = new MockSdkClient({ sessions, turns })
  const registry = new SessionStreamRegistry(data, sdk)
  const service = new SessionsService(sdk, data, registry)
  return { data, sdk, service, registry }
}
```

Add a `describe('delete', ...)` block inside `describe('SessionsService', ...)`:

```ts
describe('delete', () => {
  const sdkSession = { id: 's1', name: 'session', updatedAt: '2025-01-01T00:00:00.000Z', messageCount: 3 }

  test('a draft is removed from the list without touching the SDK', async () => {
    const { service, sdk } = freshSetup()
    const draft = service.createDraft('p1', {})

    await service.delete(draft.id)

    expect((await service.list('p1')).every((s) => s.id !== draft.id)).toBe(true)
    expect(sdk.calls.some((c) => c.method === 'deleteSession')).toBe(false)
  })

  test('an SDK session is deleted with the resolved id and the owning project dir', async () => {
    const { service, sdk } = freshSetup([sdkSession])

    await service.delete('s1')

    expect(sdk.calls).toContainEqual({ method: 'deleteSession', args: ['s1', '/tmp/x'] })
  })

  test('a materialized draft id resolves through draftMap', async () => {
    const { service, sdk, data } = freshSetup([{ ...sdkSession, id: 'sdk-1' }])
    data.update((d) => {
      d.draftMap['d1'] = 'sdk-1'
    })

    await service.delete('d1')

    expect(sdk.calls).toContainEqual({ method: 'deleteSession', args: ['sdk-1', '/tmp/x'] })
  })

  test('AppData cleanup: modelOverrides, permissionModes and draftMap entries go — usageEvents stay', async () => {
    const { service, data } = freshSetup([sdkSession])
    data.update((d) => {
      d.draftMap['d0'] = 's1'
      d.modelOverrides['s1'] = 'claude-opus-4-8'
      d.permissionModes['s1'] = 'bypassPermissions'
      d.usageEvents.push({ at: new Date().toISOString(), inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 })
    })

    await service.delete('s1')

    expect(data.get().modelOverrides['s1']).toBeUndefined()
    expect(data.get().permissionModes['s1']).toBeUndefined()
    expect(data.get().draftMap['d0']).toBeUndefined()
    // consumption history stays meaningful after the conversation is gone (spec)
    expect(data.get().usageEvents).toHaveLength(1)
  })

  test('the live stream is disposed and its turn aborted BEFORE sdk.deleteSession runs', async () => {
    const { service, sdk, registry } = freshSetup([sdkSession], [[
      { type: 'needs_permission', toolName: 'Bash', input: { command: 'sleep 999' } },
      { type: 'turn_done' },
    ]])
    const stream = registry.get('s1', 'p1')
    stream.onMessage(JSON.stringify({ type: 'user_message', text: 'go' }))
    await Bun.sleep(0)
    const params = sdk.calls.find((c) => c.method === 'runTurn')!.args[0] as { signal: AbortSignal }

    // dispose-before-delete: the SDK process must no longer be appending to the
    // JSONL when it is removed — observe the signal AT deleteSession time.
    // Array capture (not a `let`): TS can't see the closure run through the
    // opaque service.delete call, so a scalar stays narrowed to null under tsc.
    const abortedAtDelete: boolean[] = []
    const originalDelete = sdk.deleteSession.bind(sdk)
    sdk.deleteSession = async (sessionId, dir) => {
      abortedAtDelete.push(params.signal.aborted)
      await originalDelete(sessionId, dir)
    }

    await service.delete('s1')

    expect(abortedAtDelete).toEqual([true])
  })

  test('a draft whose FIRST turn is in flight has its turn aborted too (no resurrection)', async () => {
    const { service, sdk, registry } = freshSetup([], [[
      { type: 'needs_permission', toolName: 'Bash', input: { command: 'sleep 999' } },
      { type: 'turn_done' },
    ]])
    const draft = service.createDraft('p1', {})
    registry.get(draft.id, 'p1').onMessage(JSON.stringify({ type: 'user_message', text: 'go' }))
    await Bun.sleep(0)

    await service.delete(draft.id)

    const params = sdk.calls.find((c) => c.method === 'runTurn')!.args[0] as { signal: AbortSignal }
    expect(params.signal.aborted).toBe(true)
    expect((await service.list('p1')).every((s) => s.id !== draft.id)).toBe(true)
    expect(sdk.calls.some((c) => c.method === 'deleteSession')).toBe(false)
  })

  test('an unknown id throws SessionNotFoundError', async () => {
    const { service } = freshSetup()
    await expect(service.delete('ghost')).rejects.toBeInstanceOf(SessionNotFoundError)
  })

  test("an SDK 'not found' failure surfaces as SessionNotFoundError", async () => {
    const { service, sdk } = freshSetup([sdkSession])
    sdk.deleteSession = async () => {
      throw new Error('Session s1 not found in any project directory')
    }
    await expect(service.delete('s1')).rejects.toBeInstanceOf(SessionNotFoundError)
  })

  test('an unreadable project folder is skipped, not fatal — the owning scan keeps going', async () => {
    const { service, sdk, data } = freshSetup([sdkSession])
    data.update((d) => {
      d.projects.unshift({ id: 'p0', path: '/tmp/unreadable', color: 'magenta' })
    })
    const original = sdk.listSessions.bind(sdk)
    sdk.listSessions = async (cwd) => {
      if (cwd === '/tmp/unreadable') throw new Error('EACCES: dossier illisible')
      return original(cwd)
    }

    await service.delete('s1')

    expect(sdk.calls).toContainEqual({ method: 'deleteSession', args: ['s1', '/tmp/x'] })
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/src/sessions/sessions-service.test.ts`
Expected: FAIL — the missing `SessionNotFoundError` export fails the whole file at link time; once exported, `service.delete is not a function`. (`bun test` does not typecheck: the extra constructor argument alone would NOT fail — don't rely on it.)

- [ ] **Step 3: Implement the service**

In `sessions-service.ts` — imports gain `Project` (from `@atelier/shared`) and the registry type:

```ts
import type { ChatMessage, Project, SessionPermissionMode, SessionSummary } from '@atelier/shared'
import type { SessionStreamRegistry } from '../stream/session-stream'
```

Error class (exported, above the service):

```ts
/** Deletion target not found anywhere (no draft record, no SDK session in any registered project) — the route maps this to 404. */
export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session introuvable : ${id}`)
    this.name = 'SessionNotFoundError'
  }
}
```

Constructor:

```ts
constructor(
  private readonly sdk: SdkClient,
  private readonly data: AppData,
  private readonly streams: SessionStreamRegistry,
) {}
```

`delete` (add after `deleteDraft`, which stays until Task 4):

```ts
/**
 * Unified deletion — drafts and real sessions (spec 2026-07-17). Dispose runs
 * FIRST and for drafts too: a draft whose first turn is in flight must have
 * its turn aborted, or the "deleted" draft would materialize into a
 * resurrected SDK session; dispose-before-delete also guarantees the SDK
 * process is no longer appending to the JSONL when it is removed. (Accepted
 * narrow race: a JSONL flushed despite the abort simply reappears in the
 * list, deletable again.)
 */
async delete(id: string): Promise<void> {
  const isDraft = this.data.get().drafts.some((d) => d.id === id)
  this.streams.dispose(id)

  if (isDraft) {
    this.data.update((d) => {
      d.drafts = d.drafts.filter((x) => x.id !== id)
    })
    return
  }

  const sdkId = this.data.resolveSessionId(id)
  const project = await this.findOwningProject(sdkId)
  if (project === undefined) throw new SessionNotFoundError(id)

  try {
    await this.sdk.deleteSession(sdkId, project.path)
  } catch (err) {
    // The SDK throws an untyped Error when the session vanished between the
    // scan and the delete — message-sniffing is the only discriminator (spec).
    if (err instanceof Error && /not found/i.test(err.message)) throw new SessionNotFoundError(id)
    throw err
  }

  this.data.update((d) => {
    delete d.modelOverrides[sdkId]
    delete d.permissionModes[sdkId]
    for (const [draftId, mapped] of Object.entries(d.draftMap)) {
      if (mapped === sdkId) delete d.draftMap[draftId]
    }
  })
}

/**
 * DELETE /sessions/:id carries no project id — scan registered projects' dirs
 * (O(projects) local listSessions calls; fine for a personal app). Unreadable
 * folders are skipped, same tolerance as countSessions.
 */
private async findOwningProject(sdkId: string): Promise<Project | undefined> {
  for (const project of this.data.get().projects) {
    try {
      const sessions = await this.sdk.listSessions(project.path)
      if (sessions.some((s) => s.id === sdkId)) return project
    } catch {
      // unreadable folder — skip
    }
  }
  return undefined
}
```

- [ ] **Step 4: Update every construction site**

`apps/server/src/index.ts` — build the registry in the composition root, inject into both:

```ts
import { SessionStreamRegistry } from './stream/session-stream'
// ...
const data = new AppData(dataPath)
const sdk = new AgentSdkClient()
const streams = new SessionStreamRegistry(data, sdk)
const sessions = new SessionsService(sdk, data, streams)
// ...
const app = createApp({ data, sessions, sdk, streams, token, webDist, versionFile })
```

`apps/server/src/app.ts` — accept the registry instead of building it:

```ts
import type { SessionStreamRegistry } from './stream/session-stream'
// (drop the value import of SessionStreamRegistry)

export function createApp({ data, sessions, sdk, streams, token, webDist, versionFile }: { data: AppData; sessions: SessionsService; sdk: SdkClient; streams: SessionStreamRegistry; token: string; webDist?: string; versionFile?: string }): Hono {
```

and delete the line `const streams = new SessionStreamRegistry(data, sdk)` (the comment above the WS glue stays).

`apps/server/src/app.test.ts` `freshApp`:

```ts
import { SessionStreamRegistry } from './stream/session-stream'

function freshApp(webDist?: string, sdk: MockSdkClient = new MockSdkClient(), versionFile?: string) {
  const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-app-')), 'data.json')
  const data = new AppData(filePath)
  const streams = new SessionStreamRegistry(data, sdk)
  const sessions = new SessionsService(sdk, data, streams)
  const app = createApp({ data, sessions, sdk, streams, token: 'test-token', webDist, versionFile })
  return { app, data, sessions, filePath }
}
```

`apps/server/src/ide/open-in-ide.test.ts` — both constructions (l.139 and l.240) follow the same shape; e.g.:

```ts
const sdk = new MockSdkClient()
const sessions = new SessionsService(sdk, data, new SessionStreamRegistry(data, sdk))
```

(add the `SessionStreamRegistry` import; keep each test's existing structure otherwise).

- [ ] **Step 5: Run to verify everything passes**

Run: `bun test`
Expected: all green — new delete tests pass, all construction sites updated.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/sessions/sessions-service.ts apps/server/src/sessions/sessions-service.test.ts apps/server/src/index.ts apps/server/src/app.ts apps/server/src/app.test.ts apps/server/src/ide/open-in-ide.test.ts
git commit -m "feat(server): SessionsService.delete — unified draft/real deletion, registry injected from the composition root"
```

### Task 4: Rewire `DELETE /api/sessions/:id` — 204 real, 404 unknown

**Files:**
- Modify: `apps/server/src/sessions/sessions-routes.ts:55-59`
- Modify: `apps/server/src/sessions/sessions-service.ts` (remove `deleteDraft`)
- Modify: `apps/server/src/sessions/sessions-service.test.ts` (retire the old `deleteDraft` test — `delete` covers it)
- Test: `apps/server/src/app.test.ts`

- [ ] **Step 1: Write the failing route tests**

In `app.test.ts`, after the existing `DELETE /api/sessions/:id removes the draft from the list` test (l.289), add:

```ts
test('DELETE /api/sessions/:id deletes a real session through the SDK and returns 204', async () => {
  const sdk = new MockSdkClient({ sessions: [{ id: 's1', name: 'x', updatedAt: '2026-07-01T00:00:00.000Z', messageCount: 1 }] })
  const { app } = freshApp(undefined, sdk)
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
  await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify({ path: '/tmp/x' }) })

  const res = await app.request('/api/sessions/s1', { method: 'DELETE', headers })

  expect(res.status).toBe(204)
  expect(sdk.calls).toContainEqual({ method: 'deleteSession', args: ['s1', '/tmp/x'] })
})

// Regression: this used to be a silent no-op that still answered 204.
test('DELETE /api/sessions/:id with an unknown id returns 404', async () => {
  const { app } = freshApp()
  const res = await app.request('/api/sessions/ghost', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(res.status).toBe(404)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/src/app.test.ts`
Expected: the real-session test FAILS (no `deleteSession` call — the old route only filters drafts) and the unknown-id test FAILS (204 instead of 404).

- [ ] **Step 3: Rewire the route**

In `sessions-routes.ts`, import the error class (`import { SessionNotFoundError, type SessionsService } ...` — note `SessionNotFoundError` is a value import) and replace the delete handler:

```ts
app.delete('/sessions/:id', async (c) => {
  const { id } = c.req.param()
  try {
    await sessions.delete(id)
  } catch (err) {
    if (err instanceof SessionNotFoundError) return c.json({ error: 'Session introuvable' }, 404)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
  return new Response(null, { status: 204 })
})
```

- [ ] **Step 4: Remove `deleteDraft`**

Delete the `deleteDraft` method from `sessions-service.ts` (its behavior lives in `delete`). In `sessions-service.test.ts`, delete the old `deleteDraft removes it from the list` test — the `delete → a draft is removed…` test from Task 3 covers it.

- [ ] **Step 4b: Carry-forwards from Task 3's quality review**

In `sessions-service.ts`, extract the AppData cleanup into a private helper and ALSO run it in the SDK not-found branch (the session is definitively gone there — without this, its `modelOverrides`/`permissionModes`/`draftMap` entries leak forever, since any retry 404s at the scan and never reaches cleanup):

```ts
  /** Drops the session-keyed AppData entries; usageEvents stay (spec). */
  private forgetSession(sdkId: string): void {
    this.data.update((d) => {
      delete d.modelOverrides[sdkId]
      delete d.permissionModes[sdkId]
      for (const [draftId, mapped] of Object.entries(d.draftMap)) {
        if (mapped === sdkId) delete d.draftMap[draftId]
      }
    })
  }
```

In `delete()`, replace the trailing `this.data.update(...)` block with `this.forgetSession(sdkId)`, and in the catch branch:

```ts
    } catch (err) {
      // The SDK throws an untyped Error when the session vanished between the
      // scan and the delete — message-sniffing is the only discriminator (spec).
      if (err instanceof Error && /not found/i.test(err.message)) {
        // Definitively gone: forget its AppData entries too, or they leak forever.
        this.forgetSession(sdkId)
        throw new SessionNotFoundError(id)
      }
      throw err
    }
```

Two new tests in the `describe('delete', ...)` block:

```ts
  test("an SDK 'not found' failure still cleans the session's AppData entries (definitively gone)", async () => {
    const { service, sdk, data } = freshSetup([sdkSession])
    data.update((d) => {
      d.modelOverrides['s1'] = 'claude-opus-4-8'
    })
    sdk.deleteSession = async () => {
      throw new Error('Session s1 not found in any project directory')
    }

    await expect(service.delete('s1')).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(data.get().modelOverrides['s1']).toBeUndefined()
  })

  test('a non-not-found SDK failure propagates unchanged and SKIPS the AppData cleanup', async () => {
    const { service, sdk, data } = freshSetup([sdkSession])
    data.update((d) => {
      d.modelOverrides['s1'] = 'claude-opus-4-8'
    })
    sdk.deleteSession = async () => {
      throw new Error('EBUSY: fichier verrouillé')
    }

    await expect(service.delete('s1')).rejects.toThrow('EBUSY: fichier verrouillé')
    // the file may still exist — keep the session's AppData so it stays usable
    expect(data.get().modelOverrides['s1']).toBe('claude-opus-4-8')
  })
```

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: all green. The pre-existing draft DELETE test (app.test.ts l.289) must still pass through the new unified path.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/sessions/sessions-routes.ts apps/server/src/sessions/sessions-service.ts apps/server/src/sessions/sessions-service.test.ts apps/server/src/app.test.ts
git commit -m "feat(server): DELETE /api/sessions/:id handles real sessions — 404 replaces the silent no-op"
```

---

## Chunk 2: Web — confirmation dialog, sidebar affordance, App wiring, release

### Task 5: `DeleteSessionDialog` component

**Files:**
- Create: `apps/web/src/components/DeleteSessionDialog.tsx`
- Modify: `apps/web/src/styles.css` (dialog action buttons)
- Test: `apps/web/src/components/DeleteSessionDialog.test.tsx`

Controlled Radix dialog (open ⇔ `session !== null`), reusing `components/ui/dialog.tsx` (already used by `SettingsPanel`). Final copy (typographic refinement of the spec: French quotes around the name, consistent with the Topbar's « … » aria-label): title « Supprimer la conversation ? », body « Nom » sera définitivement supprimée.

- [ ] **Step 1: Write the failing tests**

Create `DeleteSessionDialog.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionSummary } from '@atelier/shared'
import { DeleteSessionDialog } from './DeleteSessionDialog'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const session: SessionSummary = {
  id: 's1',
  projectId: 'p1',
  name: 'Refresh token expiré',
  updatedAt: '2026-07-15T09:41:00.000Z',
  messageCount: 5,
  isDraft: false,
  model: 'claude-fable-5',
  permissionMode: 'default',
}

function renderDialog(target: SessionSummary | null = session) {
  const calls = { confirmed: [] as SessionSummary[], cancelled: 0 }
  render(
    <DeleteSessionDialog
      session={target}
      onConfirm={(s) => calls.confirmed.push(s)}
      onCancel={() => {
        calls.cancelled += 1
      }}
    />,
  )
  return calls
}

describe('DeleteSessionDialog', () => {
  test('closed when session is null', () => {
    renderDialog(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('shows the definitive warning with the session name', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Supprimer la conversation ?')
    expect(dialog.textContent).toContain('« Refresh token expiré » sera définitivement supprimée.')
  })

  test('a null name falls back to « Nouvelle session »', () => {
    renderDialog({ ...session, name: null })
    expect(screen.getByRole('dialog').textContent).toContain('« Nouvelle session » sera définitivement supprimée.')
  })

  test('Supprimer confirms with the session', () => {
    const calls = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))
    expect(calls.confirmed).toEqual([session])
    expect(calls.cancelled).toBe(0)
  })

  test('Annuler cancels without confirming', () => {
    const calls = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(calls.cancelled).toBe(1)
    expect(calls.confirmed).toEqual([])
  })

  test('Escape closes through onCancel', () => {
    const calls = renderDialog()
    // Radix DismissableLayer listens on ownerDocument — if this ever flakes
    // under happy-dom, dispatch the keydown on `document` instead.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(calls.cancelled).toBe(1)
    expect(calls.confirmed).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/components/DeleteSessionDialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `DeleteSessionDialog.tsx`:

```tsx
import type { SessionSummary } from '@atelier/shared'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'

export type DeleteSessionDialogProps = {
  /** The real session awaiting confirmation — null keeps the dialog closed. */
  session: SessionSummary | null
  onConfirm: (session: SessionSummary) => void
  onCancel: () => void
}

/**
 * Confirmation gate for REAL session deletion (spec 2026-07-17): the JSONL is
 * removed for good — CLI included — so a click on × must never be enough.
 * Drafts skip this dialog; their instant delete is unchanged.
 */
export function DeleteSessionDialog({ session, onConfirm, onCancel }: DeleteSessionDialogProps) {
  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="bg-surface sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Supprimer la conversation ?</DialogTitle>
          <DialogDescription>« {session?.name ?? 'Nouvelle session'} » sera définitivement supprimée.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button type="button" className="dialog-btn" onClick={onCancel}>
            Annuler
          </button>
          <button
            type="button"
            className="dialog-btn danger"
            onClick={() => {
              if (session !== null) onConfirm(session)
            }}
          >
            Supprimer
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

In `styles.css`, next to the `.perm-gate` block (same nesting level, same button grammar — red stays the destructive color, amber is reserved for permissions):

```css
/* Confirmation dialog actions (delete session) — perm-gate button grammar:
   neutral surface button, red for the destructive choice. */
.dialog-btn { font: 700 11px var(--font-sans); color: var(--color-text); background: var(--color-surface-2); border: 1px solid var(--color-line); border-radius: 7px; padding: 5px 11px; cursor: pointer; }
.dialog-btn:hover { border-color: var(--color-indigo); }
.dialog-btn.danger { color: var(--color-red); border-color: rgba(251, 111, 95, 0.4); }
.dialog-btn.danger:hover { border-color: var(--color-red); background: rgba(251, 111, 95, 0.08); }
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test apps/web/src/components/DeleteSessionDialog.test.tsx` then full `bun test`
Expected: PASS, everything green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/DeleteSessionDialog.tsx apps/web/src/components/DeleteSessionDialog.test.tsx apps/web/src/styles.css
git commit -m "feat(web): DeleteSessionDialog — confirmation gate for real session deletion"
```

### Task 6: Sidebar affordance + App wiring

**Files:**
- Modify: `apps/web/src/components/SessionListItem.tsx`
- Modify: `apps/web/src/components/SessionSidebar.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/components/SessionSidebar.test.tsx`, `apps/web/src/App.test.tsx`

One task on purpose: renaming the sidebar prop (`onDeleteDraft` → `onDelete`) and routing real sessions through the dialog touch the same seam — splitting would leave a × that does nothing.

- [ ] **Step 0: Carry-forward from Task 5's quality review — exit-animation name flash**

In `DeleteSessionDialog.tsx`: when App nulls the session, Radix keeps the content mounted through the ~200ms fade-out, during which `session?.name ?? 'Nouvelle session'` briefly shows the WRONG name in a permanent-deletion warning. Cache the last non-null session (add `import { useRef } from 'react'`):

```tsx
export function DeleteSessionDialog({ session, onConfirm, onCancel }: DeleteSessionDialogProps) {
  // Radix keeps the content mounted through the exit animation after App nulls
  // the session — cache the last real one so the copy never flashes the fallback
  // name mid-close. (Untestable under happy-dom: no animations there.)
  const lastSession = useRef(session)
  if (session !== null) lastSession.current = session
  const shown = session ?? lastSession.current
```

and use `shown?.name ?? 'Nouvelle session'` in the description (the `open` prop and the Supprimer guard keep using `session`). No test possible under happy-dom — code + comment only; the existing 6 tests must stay green.

- [ ] **Step 1: Write the failing sidebar tests**

In `SessionSidebar.test.tsx`: rename the `onDeleteDraft` prop to `onDelete` in `renderSidebar`'s props (the `calls.deleted` recorder stays). Replace the test `a draft row shows the delete button, a real session does not` with:

```tsx
test('every row shows a delete button — draft vs conversation label', () => {
  const { calls } = renderSidebar()
  const draftDelete = within(rowOf('Nouvelle session')).getByRole('button', { name: 'Supprimer le brouillon' })
  const realDelete = within(rowOf('Refresh token expiré')).getByRole('button', { name: 'Supprimer la conversation' })

  // Deleting must not also select the row.
  fireEvent.click(draftDelete)
  expect(calls.deleted).toEqual([draftSession])
  fireEvent.click(realDelete)
  expect(calls.deleted).toEqual([draftSession, realSession])
  expect(calls.selected).toEqual([])
})
```

Keep the sibling-buttons accessibility test as is (the draft row keeps its label).

- [ ] **Step 2: Write the failing App tests**

Append to `App.test.tsx` — add `within` to the existing `@testing-library/react` import (the file imports `act, cleanup, fireEvent, render, screen, waitFor` today):

```tsx
describe('App session deletion', () => {
  test('the × on a real session opens the dialog; confirming deletes through the backend', async () => {
    const deleted: string[] = []
    renderApp(
      fakeBackend({
        deleteSession: async (id) => {
          deleted.push(id)
        },
      }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Supprimer la conversation' }))
    // the dialog is a gate — nothing deleted yet
    expect(deleted).toEqual([])
    expect(screen.getByRole('dialog').textContent).toContain('« Session un » sera définitivement supprimée.')

    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))

    await waitFor(() => expect(deleted).toEqual(['s1']))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('deleting the SELECTED session deselects it and refreshes the list', async () => {
    let sessions: SessionSummary[] = [session]
    // The refetch alone empties the sidebar/Topbar — the two closing assertions
    // below are what actually pin setSelected(null) and controller.close()
    // (mutation-checked: removing either from onSuccess fails this test).
    const closes: number[] = []
    renderApp(
      fakeBackend({
        listSessions: async () => sessions,
        deleteSession: async (id) => {
          sessions = sessions.filter((s) => s.id !== id)
        },
        createSocket: () => ({ ...idleSocket, close: () => closes.push(1) }),
      }),
    )

    // select the session — the Topbar shows its rename affordance while selected
    fireEvent.click(await screen.findByText('Session un'))
    await screen.findByRole('button', { name: /renommer la session/i })

    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))

    // list refetched without the session, and the deleted session was deselected.
    // queryAllByText: while selected, 'Session un' appears TWICE (sidebar + Topbar)
    // — an all-gone assertion fails cleanly instead of a multiple-match timeout.
    await waitFor(() => expect(screen.queryAllByText('Session un')).toHaveLength(0))
    expect(screen.queryByRole('button', { name: /renommer la session/i })).toBeNull()
    // dangling selection would leave the composer enabled — pin setSelected(null)
    expect((screen.getByLabelText('Répondre à Claude') as HTMLTextAreaElement).disabled).toBe(true)
    // and the deleted session's socket must be torn down — pin controller.close()
    expect(closes.length).toBeGreaterThan(0)
  })

  test('deleting a NON-selected session leaves the selection alone', async () => {
    const other: SessionSummary = { ...session, id: 's2', name: 'Session deux' }
    let sessions: SessionSummary[] = [session, other]
    renderApp(
      fakeBackend({
        listSessions: async () => sessions,
        deleteSession: async (id) => {
          sessions = sessions.filter((s) => s.id !== id)
        },
      }),
    )

    // select 'Session un', then delete 'Session deux' from ITS row (two ×
    // buttons share the label — scope with within(row))
    fireEvent.click(await screen.findByText('Session un'))
    await screen.findByRole('button', { name: /renommer la session « session un »/i })

    const otherRow = screen.getByText('Session deux').closest('.sess') as HTMLElement
    fireEvent.click(within(otherRow).getByRole('button', { name: 'Supprimer la conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))

    // 'Session deux' leaves the list; 'Session un' stays selected — the guard
    // branch (`if (selected?.sessionId === session.id)`) must not over-deselect
    await waitFor(() => expect(screen.queryByText('Session deux')).toBeNull())
    expect(screen.getByRole('button', { name: /renommer la session « session un »/i })).toBeTruthy()
  })

  test('cancelling the dialog deletes nothing', async () => {
    const deleted: string[] = []
    renderApp(
      fakeBackend({
        deleteSession: async (id) => {
          deleted.push(id)
        },
      }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Supprimer la conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deleted).toEqual([])
  })

  test('a failed deletion surfaces a dismissible notice', async () => {
    renderApp(fakeBackend({ deleteSession: async () => Promise.reject(new Error('DELETE /api/sessions/s1 → 500')) }))

    fireEvent.click(await screen.findByRole('button', { name: 'Supprimer la conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))

    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Impossible de supprimer la session')
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(screen.queryByText(/Impossible de supprimer la session/)).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `bun test apps/web/src/components/SessionSidebar.test.tsx apps/web/src/App.test.tsx`
Expected: FAIL — real rows have no delete button; no dialog in App.

- [ ] **Step 4: Implement**

`SessionListItem.tsx` — label per kind, comment updated:

```tsx
export type SessionListItemProps = {
  session: SessionSummary
  active: boolean
  state: SessionDotState
  onSelect: () => void
  /** Every session is deletable (spec 2026-07-17): drafts instantly, real sessions behind the parent's confirmation dialog. */
  onDelete?: () => void
}
```

```tsx
{onDelete !== undefined && (
  <button
    type="button"
    className="del"
    aria-label={session.isDraft ? 'Supprimer le brouillon' : 'Supprimer la conversation'}
    onClick={onDelete}
  >
    ×
  </button>
)}
```

`SessionSidebar.tsx` — in `SessionSidebarProps` replace `onDeleteDraft: (session: SessionSummary) => void` with:

```tsx
/** Delete affordance for every row — the parent routes drafts to instant delete and real sessions to the confirmation dialog. */
onDelete: (session: SessionSummary) => void
```

In `SessionList` (destructure `onDelete` instead of `onDeleteDraft`):

```tsx
onDelete={() => onDelete(session)}
```

`App.tsx`:
1. Import the dialog: `import { DeleteSessionDialog } from './components/DeleteSessionDialog'`.
2. Add state next to `notice`: 

```tsx
/** Real session awaiting delete confirmation — null keeps the dialog closed. */
const [confirmDelete, setConfirmDelete] = useState<SessionSummary | null>(null)
```

3. Rename the `deleteDraft` mutation to `deleteSession` (same body — it already handles deselection of the deleted-selected session) and generalize its error message:

```tsx
onError: (error) => setNotice(`Impossible de supprimer la session : ${errorMessage(error)}`),
```

4. Replace the sidebar prop:

```tsx
onDelete={(session) => {
  // Drafts are empty — instant delete. A real session's JSONL is gone for
  // good (CLI included), so it goes through the confirmation dialog.
  if (session.isDraft) deleteSession.mutate(session)
  else setConfirmDelete(session)
}}
```

5. Render the dialog at shell level (next to `<Toaster />`):

```tsx
<DeleteSessionDialog
  session={confirmDelete}
  onConfirm={(session) => {
    setConfirmDelete(null)
    deleteSession.mutate(session)
  }}
  onCancel={() => setConfirmDelete(null)}
/>
```

- [ ] **Step 5: Run to verify everything passes**

Run: `bun test`
Expected: all green — sidebar, dialog, App flows, and the untouched server suites.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/SessionListItem.tsx apps/web/src/components/SessionSidebar.tsx apps/web/src/App.tsx apps/web/src/components/SessionSidebar.test.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): delete any conversation from the sidebar — confirmation dialog for real sessions"
```

### Task 7: Release — version bump + web build

**Files:**
- Modify: `version.json`

Project release workflow: bump `version.json` (concise French notes) + `bun run build:web` so a running app toasts « Une nouvelle version est disponible ».

- [ ] **Step 0: Carry-forwards from Task 6's quality review**

**(a) DELETE 404 = success (client seam).** A rapid double-× on a draft fires two DELETEs; the second 404s and raises a FALSE « Impossible de supprimer la session » banner for a delete that succeeded. The session is gone either way — treat not-found as the requested outcome, at the HTTP seam where the status is typed (`ApiError.status`, no message-sniffing). In `apps/web/src/api/client.ts`:

```ts
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await request<void>('DELETE', `/sessions/${encodeURIComponent(sessionId)}`)
  } catch (err) {
    // A 404 on DELETE means the session is already gone (double-clicked draft ×,
    // deleted from the CLI) — that IS the requested outcome, not a failure.
    if (err instanceof ApiError && err.status === 404) return
    throw err
  }
}
```

New test file `apps/web/src/api/client.test.ts` (fetch stub — module-load of client.ts is happy-dom-safe, ws.test.ts proves the env):

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { ApiError, deleteSession } from './client'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(status: number): void {
  globalThis.fetch = (async () =>
    new Response(status === 204 ? null : JSON.stringify({ error: 'x' }), { status })) as typeof fetch
}

describe('client.deleteSession', () => {
  test('204 resolves', async () => {
    stubFetch(204)
    await expect(deleteSession('s1')).resolves.toBeUndefined()
  })

  test('404 resolves — the session is already gone, which IS the requested outcome', async () => {
    stubFetch(404)
    await expect(deleteSession('ghost')).resolves.toBeUndefined()
  })

  test('a 500 still rejects with ApiError', async () => {
    stubFetch(500)
    await expect(deleteSession('s1')).rejects.toBeInstanceOf(ApiError)
  })
})
```

**(b) App test — a draft × skips the dialog** (protects the instant-draft-delete branch; without it, gating ALL sessions behind the dialog would break spec behavior with no failing test). Append inside `describe('App session deletion', ...)` in `App.test.tsx`:

```tsx
  test('a draft × deletes instantly — no confirmation dialog', async () => {
    const draft: SessionSummary = { ...session, id: 'd1', name: null, isDraft: true, messageCount: 0, permissionMode: null }
    const deleted: string[] = []
    renderApp(
      fakeBackend({
        listSessions: async () => [session, draft],
        deleteSession: async (id) => {
          deleted.push(id)
        },
      }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Supprimer le brouillon' }))

    await waitFor(() => expect(deleted).toEqual(['d1']))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
```

**(c) Failed-deletion test — assert the list survives.** In the existing `a failed deletion surfaces a dismissible notice` test, after the banner dismissal assertion, add:

```tsx
    // no optimistic removal: the row must survive a failed delete
    expect(screen.getByText('Session un')).toBeTruthy()
```

**(d) Strengthen the selected-deletion test** (owner-adopted hardening, mutation-checked): the committed `deleting the SELECTED session…` test passes even if `onSuccess` forgets `setSelected(null)` or `controller.close()` — the refetch alone empties the UI. Bring `App.test.tsx` in line with the amended plan text of that test (Task 6, Step 2): add the `closes` recorder with `createSocket: () => ({ ...idleSocket, close: () => closes.push(1) })` in the fakeBackend override, and after the existing final assertions add:

```tsx
    // dangling selection would leave the composer enabled — pin setSelected(null)
    expect((screen.getByLabelText('Répondre à Claude') as HTMLTextAreaElement).disabled).toBe(true)
    // and the deleted session's socket must be torn down — pin controller.close()
    expect(closes.length).toBeGreaterThan(0)
```

(`idleSocket` is the module-level const already in App.test.tsx; the composer textarea's aria-label « Répondre à Claude » is verified in Composer.tsx l.58.)

TDD where observable: (b) fails before nothing — it should PASS immediately (the branch exists); its value is regression protection, note that. (a)'s 404 test FAILS before the client change — watch it fail. (d) must pass on the current code (the behaviors exist since Task 6). Run `bun test apps/web` after: expected 350 + 3 (client) + 1 (draft dialog) = 354 pass. Commit these carry-forwards separately BEFORE the release bump:

```bash
git add apps/web/src/api/client.ts apps/web/src/api/client.test.ts apps/web/src/App.test.tsx
git commit -m "fix(web): treat DELETE 404 as success — no false banner on an already-gone session"
```

- [ ] **Step 1: Bump version.json**

```json
{
  "version": "0.1.7",
  "notes": [
    "Supprimer une conversation depuis la barre latérale : croix sur chaque session, confirmation avant suppression définitive (le fichier disparaît aussi du CLI)"
  ]
}
```

(Current version is 0.1.6 as of 0cfd48b. If it moved again, bump from the CURRENT value — and mirror that version in the Step 4 commit message.)

- [ ] **Step 2: Build the web bundle**

Run: `bun run build:web`
Expected: vite build succeeds.

- [ ] **Step 3: Full suite one last time**

Run: `bun test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add version.json
git commit -m "release: v0.1.7 — suppression de conversations depuis la UI"
```

(Use the version actually written in Step 1.)
