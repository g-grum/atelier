import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '@atelier/shared'
import type { RunTurnParams, SdkTurnEvent } from '../sdk/sdk-client'
import { MockSdkClient } from '../sdk/sdk-client.mock'
import { AppData, type Draft } from '../store/app-data'
import { SessionStreamRegistry } from './session-stream'

type Turns = NonNullable<ConstructorParameters<typeof MockSdkClient>[0]>['turns']

/** Drains all pending microtasks (the mock yields synchronously between awaits). */
const tick = () => Bun.sleep(0)

function setup({ turns, draft }: { turns?: Turns; draft?: Draft } = {}) {
  const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
  const data = new AppData(filePath)
  data.update((d) => {
    d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
    if (draft) d.drafts.push(draft)
  })
  const sdk = new MockSdkClient({ turns })
  const registry = new SessionStreamRegistry(data, sdk)
  return { data, sdk, registry }
}

function makeSink() {
  const events: ServerEvent[] = []
  const send = (event: ServerEvent) => {
    events.push(event)
  }
  return { events, send }
}

function ofType<T extends ServerEvent['type']>(events: ServerEvent[], type: T): Extract<ServerEvent, { type: T }>[] {
  return events.filter((event): event is Extract<ServerEvent, { type: T }> => event.type === type)
}

function clientMessage(message: object): string {
  return JSON.stringify(message)
}

function runTurnParams(sdk: MockSdkClient, index = 0): RunTurnParams {
  const calls = sdk.calls.filter((call) => call.method === 'runTurn')
  return calls[index]!.args[0] as RunTurnParams
}

describe('SessionStream', () => {
  // 1. Connect snapshot
  test('onConnect sends a status snapshot: idle, no partialText', () => {
    const { registry } = setup()
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()

    stream.onConnect(send)

    expect(events).toEqual([{ type: 'status', sessionId: 's1', state: 'idle' }])
    expect(Object.keys(events[0]!)).not.toContain('partialText')
  })

  // 2. Draft materialization
  test('user_message on a draft: mapping status, mapDraft + deferred rename, model kept, deltas, final idle', async () => {
    const draft: Draft = { id: 'd1', projectId: 'p1', name: 'refacto broker', model: 'claude-opus-4-8', createdAt: new Date().toISOString() }
    const { registry, data, sdk } = setup({
      draft,
      turns: [[
        { type: 'session_started', sessionId: 'sdk-1' },
        { type: 'text_delta', text: 'Hel' },
        { type: 'text_delta', text: 'lo' },
        { type: 'turn_done' },
      ]],
    })
    const stream = registry.get('d1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    // context resolution: cwd from the project, the draft's own model, no resume
    const params = runTurnParams(sdk)
    expect(params.cwd).toBe('/proj')
    expect(params.model).toBe('claude-opus-4-8')
    expect(params.prompt).toBe('go')
    expect(params.resumeSessionId).toBeUndefined()

    // mapping announced in a status event
    const mappings = ofType(events, 'status').filter((event) => event.mapping)
    expect(mappings).toEqual([
      { type: 'status', sessionId: 'sdk-1', state: 'streaming', mapping: { draftId: 'd1', sessionId: 'sdk-1' } },
    ])

    // AppData.mapDraft applied; the draft's model survives as the override
    expect(data.get().draftMap['d1']).toBe('sdk-1')
    expect(data.get().drafts).toEqual([])
    expect(data.get().modelOverrides['sdk-1']).toBe('claude-opus-4-8')

    // deferred rename applied through the SDK
    expect(sdk.calls).toContainEqual({ method: 'renameSession', args: ['sdk-1', 'refacto broker'] })

    // deltas streamed, stamped with the resolved id, ending idle
    const deltas = ofType(events, 'assistant_delta')
    expect(deltas.map((event) => event.text)).toEqual(['Hel', 'lo'])
    expect(deltas[0]!.sessionId).toBe('sdk-1')
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 'sdk-1', state: 'idle' })

    // singleton: both the draft id and the SDK id resolve to the same stream
    expect(registry.get('d1', 'p1')).toBe(stream)
    expect(registry.get('sdk-1', 'p1')).toBe(stream)
  })

  // 3. Permission flow
  test('needs_permission emits a permission_request; allow lets the turn finish', async () => {
    const { registry } = setup({
      turns: [[
        { type: 'needs_permission', toolName: 'Bash', input: { command: 'git push origin main' } },
        { type: 'text_delta', text: 'pushed' },
        { type: 'turn_done' },
      ]],
    })
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'push it' }))
    await tick()

    const requests = ofType(events, 'permission_request')
    expect(requests).toEqual([{
      type: 'permission_request',
      sessionId: 's1',
      requestId: expect.any(String),
      toolName: 'Bash',
      rendered: 'git push origin main',
      proposedRule: { toolName: 'Bash', matcher: 'git push' },
    }])
    // the turn is blocked on the pending permission
    expect(events.at(-1)).toEqual(requests[0]!)

    stream.onMessage(clientMessage({ type: 'permission_response', requestId: requests[0]!.requestId, decision: 'allow' }))
    await tick()

    expect(ofType(events, 'assistant_delta').map((event) => event.text)).toEqual(['pushed'])
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
  })

  test('deny produces a tool_result { ok: false }', async () => {
    const { registry } = setup({
      turns: [[
        { type: 'needs_permission', toolName: 'Bash', input: { command: 'rm -rf /' } },
        { type: 'turn_done' },
      ]],
    })
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'clean up' }))
    await tick()
    const request = ofType(events, 'permission_request')[0]!

    stream.onMessage(clientMessage({ type: 'permission_response', requestId: request.requestId, decision: 'deny' }))
    await tick()

    const results = ofType(events, 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: false, sessionId: 's1' })
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
  })

  // 4. Mid-turn reconnect
  test('mid-turn onConnect: snapshot carries streaming + partialText and re-emits the pending permission_request', async () => {
    const { registry, sdk } = setup({
      turns: [[
        { type: 'text_delta', text: 'Hel' },
        { type: 'text_delta', text: 'lo' },
        { type: 'needs_permission', toolName: 'Bash', input: { command: 'bun validate' } },
        { type: 'text_delta', text: '!' },
        { type: 'turn_done' },
      ]],
    })
    const stream = registry.get('s1', 'p1')
    const first = makeSink()
    stream.onConnect(first.send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    const second = makeSink()
    stream.onConnect(second.send)

    expect(second.events[0]).toEqual({ type: 'status', sessionId: 's1', state: 'streaming', partialText: 'Hello' })
    // re-emitted pending request is the SAME request (same requestId)
    expect(ofType(second.events, 'permission_request')).toEqual(ofType(first.events, 'permission_request'))

    // a second user_message mid-turn must not start a concurrent turn
    stream.onMessage(clientMessage({ type: 'user_message', text: 'again' }))
    await tick()
    expect(sdk.calls.filter((call) => call.method === 'runTurn')).toHaveLength(1)
  })

  // 5. Usage forwarding + recording
  test('usage SDK events are forwarded AND recorded to AppData with all four counters', async () => {
    const { registry, data } = setup({
      turns: [[
        { type: 'usage', inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 },
        { type: 'turn_done' },
      ]],
    })
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    expect(ofType(events, 'usage')).toEqual([
      { type: 'usage', sessionId: 's1', inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 },
    ])
    expect(data.get().usageEvents).toEqual([
      { at: expect.any(String), inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 },
    ])
  })

  // 6. Abort vs bare disconnect
  test("an 'abort' client message aborts the turn's signal and settles back to idle", async () => {
    const { registry, sdk } = setup({
      turns: [[
        { type: 'text_delta', text: 'a' },
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

    stream.onMessage(clientMessage({ type: 'abort' }))
    await tick()

    expect(runTurnParams(sdk).signal.aborted).toBe(true)
    // 'b' never streamed; the stream settled back to idle
    expect(ofType(events, 'assistant_delta').map((event) => event.text)).toEqual(['a'])
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
  })

  // The real AgentSdkClient does NOT return cleanly on abort like the base mock:
  // the SDK query rejects with an AbortError, which its catch converts into
  // turn_error { reason: 'This operation was aborted' }. Both real paths must
  // settle to idle — an abort is a normal Stop, never an error.
  test('abort surfacing as a turn_error event (real AgentSdkClient path) settles to idle, not error', async () => {
    class AbortAsTurnErrorSdk extends MockSdkClient {
      override async *runTurn(params: RunTurnParams): AsyncIterable<SdkTurnEvent> {
        this.calls.push({ method: 'runTurn', args: [params] })
        yield { type: 'text_delta', text: 'a' }
        // Block like the real SDK awaiting canUseTool; broker.abort() settles it.
        await params.canUseTool('Bash', { command: 'sleep 999' })
        if (params.signal.aborted) {
          yield { type: 'turn_error', reason: 'This operation was aborted' }
          return
        }
        yield { type: 'turn_done' }
      }
    }
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
    const data = new AppData(filePath)
    data.update((d) => {
      d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
    })
    const sdk = new AbortAsTurnErrorSdk()
    const registry = new SessionStreamRegistry(data, sdk)
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()
    stream.onMessage(clientMessage({ type: 'abort' }))
    await tick()

    expect(runTurnParams(sdk).signal.aborted).toBe(true)
    expect(ofType(events, 'status').every((event) => event.state !== 'error')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
  })

  test('abort surfacing as a rejected turn (AbortError thrown) settles to idle, not error', async () => {
    class AbortThrowingSdk extends MockSdkClient {
      override async *runTurn(params: RunTurnParams): AsyncIterable<SdkTurnEvent> {
        this.calls.push({ method: 'runTurn', args: [params] })
        yield { type: 'text_delta', text: 'a' }
        await params.canUseTool('Bash', { command: 'sleep 999' })
        if (params.signal.aborted) throw new DOMException('This operation was aborted', 'AbortError')
        yield { type: 'turn_done' }
      }
    }
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
    const data = new AppData(filePath)
    data.update((d) => {
      d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
    })
    const sdk = new AbortThrowingSdk()
    const registry = new SessionStreamRegistry(data, sdk)
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()
    stream.onMessage(clientMessage({ type: 'abort' }))
    await tick()

    expect(runTurnParams(sdk).signal.aborted).toBe(true)
    expect(ofType(events, 'status').every((event) => event.state !== 'error')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
  })

  test('onClose alone does NOT abort: the turn keeps running and the next connect resyncs', async () => {
    const { registry, sdk } = setup({
      turns: [[
        { type: 'text_delta', text: 'Hel' },
        { type: 'needs_permission', toolName: 'Bash', input: { command: 'bun validate' } },
        { type: 'text_delta', text: 'lo' },
        { type: 'turn_done' },
      ]],
    })
    const stream = registry.get('s1', 'p1')
    const first = makeSink()
    stream.onConnect(first.send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    stream.onClose(first.send)
    expect(runTurnParams(sdk).signal.aborted).toBe(false)
    const firstCountAfterClose = first.events.length

    // next connect resyncs: streaming snapshot with the buffered text + pending request
    const second = makeSink()
    stream.onConnect(second.send)
    expect(second.events[0]).toEqual({ type: 'status', sessionId: 's1', state: 'streaming', partialText: 'Hel' })
    const pending = ofType(second.events, 'permission_request')
    expect(pending).toHaveLength(1)

    stream.onMessage(clientMessage({ type: 'permission_response', requestId: pending[0]!.requestId, decision: 'allow' }))
    await tick()

    expect(ofType(second.events, 'assistant_delta').map((event) => event.text)).toEqual(['lo'])
    expect(second.events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
    // the closed sink received nothing after onClose
    expect(first.events).toHaveLength(firstCountAfterClose)
  })

  // 7. Turn error keeps the session usable
  test('turn_error emits status error { reason, resetAt }; a following user_message starts fresh', async () => {
    const { registry, sdk } = setup({
      turns: [
        [{ type: 'turn_error', reason: 'usage_limit', resetAt: '2026-07-15T18:00:00.000Z' }],
        [{ type: 'text_delta', text: 'ok' }, { type: 'turn_done' }],
      ],
    })
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    expect(events.at(-1)).toEqual({
      type: 'status',
      sessionId: 's1',
      state: 'error',
      error: { reason: 'usage_limit', resetAt: '2026-07-15T18:00:00.000Z' },
    })

    stream.onMessage(clientMessage({ type: 'user_message', text: 'retry' }))
    await tick()

    expect(sdk.calls.filter((call) => call.method === 'runTurn')).toHaveLength(2)
    expect(ofType(events, 'assistant_delta').map((event) => event.text)).toEqual(['ok'])
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
  })

  // Guard: an SDK failure mid-turn surfaces as a status error, never an unhandled rejection
  test('a throwing SDK call mid-turn emits status error instead of crashing', async () => {
    class ThrowingSdk extends MockSdkClient {
      override async renameSession(): Promise<void> {
        throw new Error('rename failed')
      }
    }
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
    const data = new AppData(filePath)
    data.update((d) => {
      d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
      d.drafts.push({ id: 'd1', projectId: 'p1', name: 'boom', model: 'claude-fable-5', createdAt: new Date().toISOString() })
    })
    const sdk = new ThrowingSdk({ turns: [[{ type: 'session_started', sessionId: 'sdk-1' }, { type: 'turn_done' }]] })
    const registry = new SessionStreamRegistry(data, sdk)
    const stream = registry.get('d1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 'sdk-1', state: 'error', error: { reason: 'rename failed' } })

    // The registry must have been re-keyed BEFORE the (failing) awaited rename:
    // mapDraft already redirects both ids to 'sdk-1', so a stale 'd1' key would
    // make every future get() miss and mint a DUPLICATE stream, stranding this one.
    expect(registry.get('d1', 'p1')).toBe(stream)
    expect(registry.get('sdk-1', 'p1')).toBe(stream)
  })

  // Guard: a turn against an unknown project must fail loudly, not crash the process
  test('user_message with an unknown projectId emits a status error instead of throwing', async () => {
    const { registry } = setup()
    const stream = registry.get('s1', 'nope')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    const last = events.at(-1)
    expect(last).toMatchObject({ type: 'status', state: 'error' })
  })
})
