import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '@atelier/shared'
import type { RunTurnParams, SdkTurnEvent } from '../sdk/sdk-client'
import { MockSdkClient } from '../sdk/sdk-client.mock'
import { AppData, type Draft } from '../store/app-data'
import { SessionStream, SessionStreamRegistry } from './session-stream'

type Turns = NonNullable<ConstructorParameters<typeof MockSdkClient>[0]>['turns']

/** Drains all pending microtasks (the mock yields synchronously between awaits). */
const tick = () => Bun.sleep(0)

function setup({ turns, draft, isAutopilot }: { turns?: Turns; draft?: Draft; isAutopilot?: (sessionId: string) => boolean } = {}) {
  const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
  const data = new AppData(filePath)
  data.update((d) => {
    d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
    if (draft) d.drafts.push(draft)
  })
  const sdk = new MockSdkClient({ turns })
  const registry = new SessionStreamRegistry(data, sdk, isAutopilot)
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

  // 1bis-a. onStatusChange hook — feeds the future status hub
  test('émet chaque transition d’état via onStatusChange (streaming au démarrage, idle en fin)', async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
    const data = new AppData(filePath)
    data.update((d) => {
      d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
    })
    const sdk = new MockSdkClient({ turns: [[{ type: 'turn_done' }]] })
    const states: Array<{ sessionId: string; state: string }> = []
    const stream = new SessionStream({
      id: 's1',
      projectId: 'p1',
      data,
      sdk,
      onStatusChange: (sessionId, state) => states.push({ sessionId, state }),
    })

    stream.onMessage(clientMessage({ type: 'user_message', text: 'hi' }))
    await tick()

    expect(states).toEqual([
      { sessionId: 's1', state: 'streaming' },
      { sessionId: 's1', state: 'idle' },
    ])
  })

  // 1bis-b. A throwing subscriber must NOT corrupt the session's own turn state:
  // the turn_done → setState('idle') notify runs inside runTurn's try; an escaping
  // throw would bubble into the catch and flip a successful turn to 'error'.
  test('un onStatusChange qui lève ne corrompt pas l’état du tour (reste idle, pas error)', async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
    const data = new AppData(filePath)
    data.update((d) => {
      d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
    })
    const sdk = new MockSdkClient({ turns: [[{ type: 'turn_done' }]] })
    const stream = new SessionStream({
      id: 's1',
      projectId: 'p1',
      data,
      sdk,
      onStatusChange: () => {
        throw new Error('sink boom')
      },
    })

    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      stream.onMessage(clientMessage({ type: 'user_message', text: 'hi' }))
      await tick()
    } finally {
      errorLog.mockRestore()
    }

    expect(stream.currentState).toBe('idle')
  })

  // 1ter. Routage QCM (spec AskUserQuestion) + skip-permissions en auto-allow sélectif
  // (remplace les anciens tests « bypass flag » : le mode SDK bypassPermissions n'existe plus)
  describe('routage QCM', () => {
    const VALID_INPUT = {
      questions: [{
        question: 'Quelle approche ?',
        header: 'Approche',
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
        multiSelect: false,
      }],
    }

    test('AskUserQuestion publie question_request (pas permission_request) et la réponse settle allow+answers', async () => {
      const { registry, sdk } = setup({ turns: [[{ type: 'turn_done' }]] })
      const stream = registry.get('s1', 'p1')
      const { events, send } = makeSink()
      stream.onConnect(send)

      stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
      await tick()

      const result = runTurnParams(sdk).canUseTool('AskUserQuestion', VALID_INPUT)
      await tick()

      const requests = ofType(events, 'question_request')
      expect(requests).toEqual([{
        type: 'question_request',
        sessionId: 's1',
        requestId: expect.any(String),
        questions: VALID_INPUT.questions,
      }])
      expect(ofType(events, 'permission_request')).toHaveLength(0)

      stream.onMessage(clientMessage({ type: 'question_response', requestId: requests[0]!.requestId, answers: { 'Quelle approche ?': 'A' } }))

      await expect(result).resolves.toEqual({
        behavior: 'allow',
        updatedInput: { ...VALID_INPUT, answers: { 'Quelle approche ?': 'A' } },
      })
    })

    test('bypassPermissions : tout est auto-allow SAUF AskUserQuestion', async () => {
      const { registry, data, sdk } = setup({ turns: [[{ type: 'turn_done' }]] })
      data.update((d) => {
        d.permissionModes['s1'] = 'bypassPermissions'
      })
      const stream = registry.get('s1', 'p1')
      const { events, send } = makeSink()
      stream.onConnect(send)

      stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
      await tick()
      const canUseTool = runTurnParams(sdk).canUseTool

      // auto-allow immédiat, sans jamais consulter l'utilisateur
      await expect(canUseTool('Bash', { command: 'ls' })).resolves.toEqual({ behavior: 'allow' })
      expect(ofType(events, 'permission_request')).toHaveLength(0)

      // ... mais le QCM remonte toujours à la UI (reste pendant)
      const qcm = canUseTool('AskUserQuestion', VALID_INPUT)
      await tick()
      expect(ofType(events, 'question_request')).toHaveLength(1)
      // pendant = la promesse n'a PAS settle sans réponse de la UI
      await expect(Promise.race([qcm.then(() => 'settled'), Promise.resolve('pending')])).resolves.toBe('pending')
    })

    test('un draft bypassPermissions auto-allow aussi (résolution draft-first)', async () => {
      const draft: Draft = { id: 'd1', projectId: 'p1', name: null, model: 'claude-fable-5', createdAt: new Date().toISOString(), permissionMode: 'bypassPermissions' }
      const { registry, sdk } = setup({ draft, turns: [[{ type: 'turn_done' }]] })

      registry.get('d1', 'p1').onMessage(clientMessage({ type: 'user_message', text: 'go' }))
      await tick()

      await expect(runTurnParams(sdk).canUseTool('Bash', { command: 'ls' })).resolves.toEqual({ behavior: 'allow' })
    })

    test("bypassPermissions n'est plus transmis au SDK", async () => {
      const { registry, data, sdk } = setup({ turns: [[{ type: 'turn_done' }]] })
      data.update((d) => {
        d.permissionModes['s1'] = 'bypassPermissions'
      })

      registry.get('s1', 'p1').onMessage(clientMessage({ type: 'user_message', text: 'go' }))
      await tick()

      // assertion runtime : la clé ne doit plus exister du tout dans les params
      expect('bypassPermissions' in (runTurnParams(sdk) as object)).toBe(false)
    })

    test('onConnect ré-émet les question_request pendants', async () => {
      const { registry, sdk } = setup({ turns: [[{ type: 'turn_done' }]] })
      const stream = registry.get('s1', 'p1')
      const first = makeSink()
      stream.onConnect(first.send)

      stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
      await tick()
      void runTurnParams(sdk).canUseTool('AskUserQuestion', VALID_INPUT)
      await tick()

      const second = makeSink()
      stream.onConnect(second.send)

      // snapshot status + LA MÊME requête pendante (même requestId)
      expect(second.events[0]).toMatchObject({ type: 'status', sessionId: 's1' })
      expect(ofType(second.events, 'question_request')).toEqual(ofType(first.events, 'question_request'))
      expect(ofType(second.events, 'question_request')).toHaveLength(1)
    })

    test('abort deny les questions pendantes', async () => {
      const { registry, sdk } = setup({ turns: [[{ type: 'turn_done' }]] })
      const stream = registry.get('s1', 'p1')

      stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
      await tick()
      const result = runTurnParams(sdk).canUseTool('AskUserQuestion', VALID_INPUT)
      await tick()

      stream.onMessage(clientMessage({ type: 'abort' }))

      await expect(result).resolves.toEqual({ behavior: 'deny', message: 'Session aborted' })
    })

    test('dispose deny les questions pendantes', async () => {
      const { registry, sdk } = setup({ turns: [[{ type: 'turn_done' }]] })
      const stream = registry.get('s1', 'p1')

      stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
      await tick()
      const result = runTurnParams(sdk).canUseTool('AskUserQuestion', VALID_INPUT)
      await tick()

      registry.dispose('s1')

      await expect(result).resolves.toEqual({ behavior: 'deny', message: 'Session aborted' })
    })

    test('tool_use/tool_result AskUserQuestion ne sont pas broadcastés (la carte QCM représente le tour)', async () => {
      const { registry } = setup({
        turns: [[
          { type: 'tool_use', toolUseId: 't1', toolName: 'AskUserQuestion', input: VALID_INPUT },
          { type: 'tool_result', toolUseId: 't1', ok: true, summary: 'ok' },
          { type: 'tool_use', toolUseId: 't2', toolName: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', toolUseId: 't2', ok: true, summary: 'ok' },
          { type: 'turn_done' },
        ]],
      })
      const stream = registry.get('s1', 'p1')
      const { events, send } = makeSink()
      stream.onConnect(send)

      stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
      await tick()

      // ni le tool_use t1 ni le tool_result t1 ne sortent — la carte QCM suffit
      expect(ofType(events, 'tool_use').map((event) => event.toolUseId)).toEqual(['t2'])
      expect(ofType(events, 'tool_result').map((event) => event.toolUseId)).toEqual(['t2'])
    })

    test('le reset de partialText au tool_use AskUserQuestion est conservé', async () => {
      const { registry } = setup({
        turns: [[
          { type: 'text_delta', text: 'avant' },
          { type: 'tool_use', toolUseId: 't1', toolName: 'AskUserQuestion', input: VALID_INPUT },
          // tient le tour ouvert pour qu'une reconnexion observe le snapshot streaming
          { type: 'needs_permission', toolName: 'Bash', input: { command: 'sleep 999' } },
          { type: 'turn_done' },
        ]],
      })
      const stream = registry.get('s1', 'p1')
      const first = makeSink()
      stream.onConnect(first.send)

      stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
      await tick()

      // le tool_use QCM (même supprimé du broadcast) clôt le run de texte :
      // le snapshot de reconnexion ne re-sert PAS 'avant' comme run en cours
      const second = makeSink()
      stream.onConnect(second.send)
      expect(second.events[0]).toEqual({ type: 'status', sessionId: 's1', state: 'streaming', partialText: '' })

      // libère la permission bloquante pour que le tour settle
      const pending = ofType(second.events, 'permission_request')
      expect(pending).toHaveLength(1)
      stream.onMessage(clientMessage({ type: 'permission_response', requestId: pending[0]!.requestId, decision: 'allow' }))
      await tick()
      expect(second.events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
    })
  })

  // 1ter. Plan rate limits — broadcast live + persisted for the REST snapshot
  test('a rate_limit turn event is broadcast to the sinks and persisted per window', async () => {
    const { registry, data } = setup({
      turns: [[
        { type: 'rate_limit', window: 'five_hour', utilization: 34, status: 'allowed', resetsAt: '2026-07-17T16:00:00.000Z' },
        { type: 'turn_done' },
      ]],
    })
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    const broadcasts = ofType(events, 'rate_limit')
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]?.limit).toMatchObject({ window: 'five_hour', utilization: 34, status: 'allowed', resetsAt: '2026-07-17T16:00:00.000Z' })
    expect(typeof broadcasts[0]?.limit.recordedAt).toBe('string')

    expect(data.get().rateLimits['five_hour']?.utilization).toBe(34)
  })

  // 1quater. Slash commands — la liste peut changer en cours de session
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

  // tool_use forwarding + the partial-text run reset it implies
  test("tool_use is forwarded with describeToolUse's shape and closes the partial-text run for reconnect snapshots", async () => {
    const { registry } = setup({
      turns: [[
        { type: 'text_delta', text: 'Hel' },
        { type: 'text_delta', text: 'lo' },
        { type: 'tool_use', toolUseId: 'tu-1', toolName: 'Edit', input: { file_path: '/proj/src/main.ts', old_string: 'old', new_string: 'new\nline' } },
        { type: 'text_delta', text: 'wor' },
        // holds the turn open mid-stream so a reconnect can observe the snapshot
        { type: 'needs_permission', toolName: 'Bash', input: { command: 'sleep 999' } },
        { type: 'turn_done' },
      ]],
    })
    const stream = registry.get('s1', 'p1')
    const first = makeSink()
    stream.onConnect(first.send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    // (a) the tool_use ServerEvent carries kind/summary/file/diffstat from
    // describeToolUse, plus toolUseId and the stamped sessionId (protocol.ts shape)
    expect(ofType(first.events, 'tool_use')).toEqual([{
      type: 'tool_use',
      sessionId: 's1',
      toolUseId: 'tu-1',
      kind: 'Edit',
      summary: 'main.ts',
      file: '/proj/src/main.ts',
      diffstat: { added: 2, removed: 1 },
    }])

    // (b) the tool_use closed the 'Hello' run — a reconnect snapshot buffers only
    // the post-tool run 'wor', never 'Hellowor'
    const second = makeSink()
    stream.onConnect(second.send)
    expect(second.events[0]).toEqual({ type: 'status', sessionId: 's1', state: 'streaming', partialText: 'wor' })

    // release the held permission so the turn settles to idle
    const pending = ofType(second.events, 'permission_request')
    expect(pending).toHaveLength(1)
    stream.onMessage(clientMessage({ type: 'permission_response', requestId: pending[0]!.requestId, decision: 'allow' }))
    await tick()
    expect(second.events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
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

  // The real AgentSdkClient keeps awaiting the SDK query stream's close AFTER
  // yielding turn_done from the 'result' message — so the generator drains
  // asynchronously past turn_done while state is already 'idle'. A user_message
  // in that gap legitimately starts the next turn; the draining turn's teardown
  // must not touch fields the new turn now owns. (The base mock completes
  // synchronously, which is why these need bespoke generators.)
  test('a turn draining past turn_done must not tear down the next turn (abort stays live, no spurious idle)', async () => {
    let releaseDrain!: () => void
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    class DrainGapSdk extends MockSdkClient {
      private turnNo = 0
      override async *runTurn(params: RunTurnParams): AsyncIterable<SdkTurnEvent> {
        this.calls.push({ method: 'runTurn', args: [params] })
        if (this.turnNo++ === 0) {
          yield { type: 'text_delta', text: 'one' }
          yield { type: 'turn_done' }
          await drainGate // the post-turn_done drain gap
          return
        }
        // turn 2: held open on canUseTool so the drain races against it mid-turn
        yield { type: 'text_delta', text: 'two' }
        await params.canUseTool('Bash', { command: 'sleep 999' })
        if (params.signal.aborted) return
        yield { type: 'turn_done' }
      }
    }
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
    const data = new AppData(filePath)
    data.update((d) => {
      d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
    })
    const sdk = new DrainGapSdk()
    const registry = new SessionStreamRegistry(data, sdk)
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'first' }))
    await tick()
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })

    // turn 1's generator is still draining; turn 2 starts in that gap
    stream.onMessage(clientMessage({ type: 'user_message', text: 'second' }))
    await tick()
    const countBeforeDrain = events.length

    releaseDrain()
    await tick()

    // no spurious idle mid-turn-2 — that would let a further user_message
    // start a truly concurrent turn (one-turn-per-session invariant)
    expect(events.length).toBe(countBeforeDrain)

    // Stop is still alive: an abort message aborts TURN 2's signal
    stream.onMessage(clientMessage({ type: 'abort' }))
    await tick()
    expect(runTurnParams(sdk, 1).signal.aborted).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
  })

  test('a turn rejecting while draining past turn_done must not clobber the next turn with an error', async () => {
    let failDrain!: (err: Error) => void
    const drainGate = new Promise<void>((_resolve, reject) => {
      failDrain = reject
    })
    class DrainRejectSdk extends MockSdkClient {
      private turnNo = 0
      override async *runTurn(params: RunTurnParams): AsyncIterable<SdkTurnEvent> {
        this.calls.push({ method: 'runTurn', args: [params] })
        if (this.turnNo++ === 0) {
          yield { type: 'turn_done' }
          await drainGate // rejects: e.g. the SDK stream's close fails after 'result'
          return
        }
        yield { type: 'text_delta', text: 'two' }
        await params.canUseTool('Bash', { command: 'sleep 999' })
        if (params.signal.aborted) return
        yield { type: 'turn_done' }
      }
    }
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
    const data = new AppData(filePath)
    data.update((d) => {
      d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
    })
    const sdk = new DrainRejectSdk()
    const registry = new SessionStreamRegistry(data, sdk)
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'first' }))
    await tick()
    stream.onMessage(clientMessage({ type: 'user_message', text: 'second' }))
    await tick()

    failDrain(new Error('stream close failed'))
    await tick()

    // turn 1's late rejection must not surface as an error over turn 2
    expect(ofType(events, 'status').every((event) => event.state !== 'error')).toBe(true)

    // and must not have knocked the state off 'streaming': a user_message here
    // must still be dropped by the one-turn guard
    stream.onMessage(clientMessage({ type: 'user_message', text: 'third' }))
    await tick()
    expect(sdk.calls.filter((call) => call.method === 'runTurn')).toHaveLength(2)

    // turn 2 finishes normally once its held permission is allowed
    const pending = ofType(events, 'permission_request')
    expect(pending).toHaveLength(1)
    stream.onMessage(clientMessage({ type: 'permission_response', requestId: pending[0]!.requestId, decision: 'allow' }))
    await tick()
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
  })

  // Same drain-gap race, event flavor: the real AgentSdkClient's generator catch
  // converts ANY late rejection into a YIELDED turn_error (sdk-client.ts) — so
  // post-turn_done failures arrive as events, not rejections. A drained turn's
  // late turn_error must be dropped, not routed through handleTurnEvent.
  test('a late turn_error EVENT from a turn draining past turn_done must not clobber the next turn', async () => {
    let releaseDrain!: () => void
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    class DrainErrorEventSdk extends MockSdkClient {
      private turnNo = 0
      override async *runTurn(params: RunTurnParams): AsyncIterable<SdkTurnEvent> {
        this.calls.push({ method: 'runTurn', args: [params] })
        if (this.turnNo++ === 0) {
          yield { type: 'turn_done' }
          await drainGate // the post-turn_done drain gap
          // the real client's catch yields the close failure as a turn_error event
          yield { type: 'turn_error', reason: 'stream close failed' }
          return
        }
        // turn 2: held open on canUseTool so the late event lands mid-turn
        yield { type: 'text_delta', text: 'two' }
        await params.canUseTool('Bash', { command: 'sleep 999' })
        if (params.signal.aborted) return
        yield { type: 'turn_done' }
      }
    }
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
    const data = new AppData(filePath)
    data.update((d) => {
      d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
    })
    const sdk = new DrainErrorEventSdk()
    const registry = new SessionStreamRegistry(data, sdk)
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'first' }))
    await tick()
    // turn 1's generator is still draining; turn 2 starts in that gap
    stream.onMessage(clientMessage({ type: 'user_message', text: 'second' }))
    await tick()
    const countBeforeDrain = events.length

    releaseDrain()
    await tick()

    // (a) no spurious status error broadcast mid-turn-2
    expect(ofType(events, 'status').every((event) => event.state !== 'error')).toBe(true)
    expect(events.length).toBe(countBeforeDrain)

    // (b) state was not knocked off 'streaming': a user_message here must still
    // be dropped by the one-turn guard, never starting a truly concurrent turn
    stream.onMessage(clientMessage({ type: 'user_message', text: 'third' }))
    await tick()
    expect(sdk.calls.filter((call) => call.method === 'runTurn')).toHaveLength(2)

    // turn 2 finishes normally once its held permission is allowed
    const pending = ofType(events, 'permission_request')
    expect(pending).toHaveLength(1)
    stream.onMessage(clientMessage({ type: 'permission_response', requestId: pending[0]!.requestId, decision: 'allow' }))
    await tick()
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
  })

  test('a late turn_error EVENT with no next turn must not flip an idle-settled session to error', async () => {
    let releaseDrain!: () => void
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    class DrainErrorEventSdk extends MockSdkClient {
      override async *runTurn(params: RunTurnParams): AsyncIterable<SdkTurnEvent> {
        this.calls.push({ method: 'runTurn', args: [params] })
        yield { type: 'turn_done' }
        await drainGate
        yield { type: 'turn_error', reason: 'stream close failed' }
      }
    }
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
    const data = new AppData(filePath)
    data.update((d) => {
      d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
    })
    const sdk = new DrainErrorEventSdk()
    const registry = new SessionStreamRegistry(data, sdk)
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
    const countBeforeDrain = events.length

    releaseDrain()
    await tick()

    // the settled-idle session must not flip to 'error' after the fact
    expect(ofType(events, 'status').every((event) => event.state !== 'error')).toBe(true)
    expect(events.length).toBe(countBeforeDrain)

    // a fresh connect still sees idle, not error
    const second = makeSink()
    stream.onConnect(second.send)
    expect(second.events[0]).toEqual({ type: 'status', sessionId: 's1', state: 'idle' })
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

  // Bug fix (live acceptance pass): at session_started the SDK CLI has not yet
  // flushed the session JSONL to ~/.claude/projects, so the deferred rename
  // threw "Session not found in any project directory" — and the exception
  // killed the ENTIRE first turn (no mapping, no deltas, no usage, status
  // error). A rename failure must never kill the turn: a lost rename is
  // cosmetic (spec: it surfaces as a toast), a lost turn is not.
  test('a throwing renameSession never kills the draft turn: mapping broadcast, deltas, usage recorded, idle — rename attempted once, error logged', async () => {
    class ThrowingRenameSdk extends MockSdkClient {
      override async renameSession(sessionId: string, name: string): Promise<void> {
        await super.renameSession(sessionId, name) // records the attempt in calls
        throw new Error('Session sdk-1 not found in any project directory')
      }
    }
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
    const data = new AppData(filePath)
    data.update((d) => {
      d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
      d.drafts.push({ id: 'd1', projectId: 'p1', name: 'boom', model: 'claude-fable-5', createdAt: new Date().toISOString() })
    })
    const sdk = new ThrowingRenameSdk({
      turns: [[
        { type: 'session_started', sessionId: 'sdk-1' },
        { type: 'text_delta', text: 'Hel' },
        { type: 'text_delta', text: 'lo' },
        { type: 'usage', inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 },
        { type: 'turn_done' },
      ]],
    })
    const registry = new SessionStreamRegistry(data, sdk)
    const stream = registry.get('d1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    // mockRestore clears recorded calls — capture them in a local array instead.
    const loggedErrors: unknown[][] = []
    const errorLog = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      loggedErrors.push(args)
    })
    try {
      stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
      await tick()
    } finally {
      errorLog.mockRestore()
    }

    // the mapping still reached the client
    expect(ofType(events, 'status').filter((event) => event.mapping)).toEqual([
      { type: 'status', sessionId: 'sdk-1', state: 'streaming', mapping: { draftId: 'd1', sessionId: 'sdk-1' } },
    ])
    // the deltas still streamed
    expect(ofType(events, 'assistant_delta').map((event) => event.text)).toEqual(['Hel', 'lo'])
    // the usage was still recorded
    expect(data.get().usageEvents).toEqual([
      { at: expect.any(String), inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 },
    ])
    // the turn settled idle — never error
    expect(ofType(events, 'status').every((event) => event.state !== 'error')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 'sdk-1', state: 'idle' })
    // the rename was attempted exactly once, and its failure was logged, not thrown
    expect(sdk.calls.filter((call) => call.method === 'renameSession')).toEqual([
      { method: 'renameSession', args: ['sdk-1', 'boom'] },
    ])
    expect(loggedErrors.length).toBeGreaterThanOrEqual(1)
    expect(loggedErrors.some((args) => args.some((a) => a instanceof Error && a.message.includes('not found')))).toBe(true)

    // The registry must have been re-keyed at session_started (with mapDraft):
    // mapDraft already redirects both ids to 'sdk-1', so a stale 'd1' key would
    // make every future get() miss and mint a DUPLICATE stream, stranding this one.
    expect(registry.get('d1', 'p1')).toBe(stream)
    expect(registry.get('sdk-1', 'p1')).toBe(stream)
  })

  // Companion timing test: the deferred rename must run at TURN END — by then
  // the SDK CLI has flushed the session JSONL — never at session_started.
  test('the deferred rename is applied at TURN END: after every content event of the turn, before the idle settle', async () => {
    const { events, send } = makeSink()
    let eventsSeenAtRename = -1
    class RenameOrderSdk extends MockSdkClient {
      override async renameSession(sessionId: string, name: string): Promise<void> {
        eventsSeenAtRename = events.length
        await super.renameSession(sessionId, name)
      }
    }
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-stream-')), 'data.json')
    const data = new AppData(filePath)
    data.update((d) => {
      d.projects.push({ id: 'p1', path: '/proj', color: 'cyan' })
      d.drafts.push({ id: 'd1', projectId: 'p1', name: 'refacto broker', model: 'claude-fable-5', createdAt: new Date().toISOString() })
    })
    const sdk = new RenameOrderSdk({
      turns: [[
        { type: 'session_started', sessionId: 'sdk-1' },
        { type: 'text_delta', text: 'Hel' },
        { type: 'tool_use', toolUseId: 'tu-1', toolName: 'Bash', input: { command: 'bun test' } },
        { type: 'tool_result', toolUseId: 'tu-1', ok: true, summary: 'ok' },
        { type: 'text_delta', text: 'lo' },
        { type: 'turn_done' },
      ]],
    })
    const registry = new SessionStreamRegistry(data, sdk)
    const stream = registry.get('d1', 'p1')
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    // rename called exactly once, with the deferred name, AFTER runTurn started
    expect(sdk.calls.filter((call) => call.method === 'renameSession')).toEqual([
      { method: 'renameSession', args: ['sdk-1', 'refacto broker'] },
    ])
    expect(sdk.calls.map((call) => call.method)).toEqual(['runTurn', 'renameSession'])

    // at rename time, EVERY event of the turn except the final idle settle had
    // already been broadcast (deltas, tool_use, tool_result all processed)
    expect(eventsSeenAtRename).toBe(events.length - 1)
    expect(ofType(events, 'assistant_delta').map((event) => event.text)).toEqual(['Hel', 'lo'])
    expect(ofType(events, 'tool_result')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'status', sessionId: 'sdk-1', state: 'idle' })
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

  // 9. Status hub — snapshot on connect + broadcast of transitions
  test('le hub envoie un snapshot à la connexion puis diffuse les transitions', async () => {
    const { registry } = setup({ turns: [[{ type: 'turn_done' }]] })
    const s = registry.get('s1', 'p1')
    s.onMessage(clientMessage({ type: 'user_message', text: 'hi' })) // → streaming

    const seen: Array<{ sessionId: string; state: string }> = []
    registry.onStatusConnect((e) => seen.push({ sessionId: e.sessionId, state: e.state }))
    // initial snapshot: s1 already streaming
    expect(seen).toContainEqual({ sessionId: 's1', state: 'streaming' })

    await tick() // drain the turn

    // broadcast transition: s1 → idle
    expect(seen).toContainEqual({ sessionId: 's1', state: 'idle' })
  })

  test('un sink de statut qui lève ne prive pas les autres sinks des transitions', async () => {
    const { registry } = setup({ turns: [[{ type: 'turn_done' }]] })
    // le sink fautif est enregistré EN PREMIER pour rendre l'échec déterministe
    registry.onStatusConnect(() => {
      throw new Error('sink boom')
    })
    const seen: Array<{ sessionId: string; state: string }> = []
    registry.onStatusConnect((e) => seen.push({ sessionId: e.sessionId, state: e.state }))

    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = registry.get('s1', 'p1')
      s.onMessage(clientMessage({ type: 'user_message', text: 'hi' })) // → streaming
      await tick() // drain the turn → idle
    } finally {
      errorLog.mockRestore()
    }

    // le bon sink reçoit les transitions malgré le sink fautif
    expect(seen).toContainEqual({ sessionId: 's1', state: 'streaming' })
    expect(seen).toContainEqual({ sessionId: 's1', state: 'idle' })
  })

  test('onStatusClose retire le sink', () => {
    const { registry } = setup({ turns: [[{ type: 'turn_done' }]] })
    const seen: unknown[] = []
    const sink = (e: { sessionId: string }) => seen.push(e)
    registry.onStatusConnect(sink)
    const before = seen.length
    registry.onStatusClose(sink)
    registry.get('s2', 'p1').onMessage(clientMessage({ type: 'user_message', text: 'x' }))
    expect(seen.length).toBe(before) // nothing after close (beyond the snapshot already received)
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
})

// 10. Hub élargi (spec 2026-08-05) : publication d'événements autopilot
describe('status hub — publish', () => {
  test('publish diffuse un événement arbitraire du hub à tous les sinks', () => {
    const { registry } = setup()
    const seen: unknown[] = []
    registry.onStatusConnect((e) => seen.push(e))
    const event = { type: 'autopilot_status' as const, autopilot: { run: null, items: [] } }
    registry.publish(event)
    expect(seen).toContainEqual(event)
  })

  test('un sink qui lève ne prive pas les suivants de publish', () => {
    const { registry } = setup()
    registry.onStatusConnect(() => {
      throw new Error('sink boom')
    })
    const seen: unknown[] = []
    registry.onStatusConnect((e) => seen.push(e))
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      registry.publish({ type: 'autopilot_status', autopilot: { run: null, items: [] } })
    } finally {
      errorLog.mockRestore()
    }
    expect(seen).toHaveLength(1)
  })
})

// 11. Sessions autopilot (spec 2026-08-05) : AskUserQuestion refusé net — personne ne répondra
describe('deny AskUserQuestion en session autopilot', () => {
  const VALID_INPUT = {
    questions: [{
      question: 'Quelle approche ?',
      header: 'Approche',
      options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      multiSelect: false,
    }],
  }

  test('AskUserQuestion est refusé immédiatement (pas de QuestionBroker) quand isAutopilot matche', async () => {
    const { registry, sdk } = setup({ turns: [[{ type: 'turn_done' }]], isAutopilot: (id) => id === 's1' })
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    await expect(runTurnParams(sdk).canUseTool('AskUserQuestion', VALID_INPUT)).resolves.toEqual({
      behavior: 'deny',
      message: 'Session autonome — décide seul et continue.',
    })
    expect(ofType(events, 'question_request')).toHaveLength(0)
  })

  test('AskUserQuestion va au QuestionBroker pour une session normale (prédicat faux)', async () => {
    const { registry, sdk } = setup({ turns: [[{ type: 'turn_done' }]], isAutopilot: () => false })
    const stream = registry.get('s1', 'p1')
    const { events, send } = makeSink()
    stream.onConnect(send)

    stream.onMessage(clientMessage({ type: 'user_message', text: 'go' }))
    await tick()

    void runTurnParams(sdk).canUseTool('AskUserQuestion', VALID_INPUT)
    await tick()
    expect(ofType(events, 'question_request')).toHaveLength(1)
  })
})
