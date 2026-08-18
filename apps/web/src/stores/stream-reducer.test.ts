/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import type { ChatMessage, ServerEvent } from '@atelier/shared'
import { initialState, reduce, reset, resolvePermission, resolveQuestion, type StreamState } from './stream-reducer'

const S = 's1'
const AT = '2026-07-15T10:00:00.000Z'

type ToolUseEvent = Extract<ServerEvent, { type: 'tool_use' }>
type StatusEvent = Extract<ServerEvent, { type: 'status' }>

const delta = (text: string): ServerEvent => ({ type: 'assistant_delta', sessionId: S, text })
const toolUse = (over: Partial<Omit<ToolUseEvent, 'type' | 'sessionId'>> = {}): ServerEvent => ({
  type: 'tool_use',
  sessionId: S,
  toolUseId: 't1',
  kind: 'Bash',
  summary: 'bun test',
  ...over,
})
const status = (over: Partial<Omit<StatusEvent, 'type' | 'sessionId'>> & Pick<StatusEvent, 'state'>): ServerEvent => ({
  type: 'status',
  sessionId: S,
  ...over,
})
const permission = (requestId = 'req1'): ServerEvent => ({
  type: 'permission_request',
  sessionId: S,
  requestId,
  toolName: 'Bash',
  rendered: 'git push origin main',
  proposedRule: { toolName: 'Bash', matcher: 'git push' },
})

const run = (events: ServerEvent[], from: StreamState = initialState()): StreamState => events.reduce(reduce, from)

describe('assistant_delta', () => {
  test('deltas append to ONE streaming assistant item', () => {
    const state = run([delta('Bon'), delta('jour'), delta(' !')])
    expect(state.items).toEqual([{ kind: 'assistant', text: 'Bonjour !', streaming: true }])
    expect(state.status).toBe('streaming')
  })

  test('reduce is pure — the input state is not mutated', () => {
    const before = run([delta('a')])
    const itemsBefore = before.items
    reduce(before, delta('b'))
    expect(before.items).toBe(itemsBefore)
    expect(before.items).toEqual([{ kind: 'assistant', text: 'a', streaming: true }])
  })
})

describe('tool_use', () => {
  test('closes the current text run — the next delta opens a NEW assistant item', () => {
    const state = run([delta('Je lance les tests.'), toolUse(), delta('Tout passe.')])
    expect(state.items).toHaveLength(3)
    expect(state.items[0]).toEqual({ kind: 'assistant', text: 'Je lance les tests.', streaming: false })
    expect(state.items[2]).toEqual({ kind: 'assistant', text: 'Tout passe.', streaming: true })
  })

  test('appends a tool item carrying kind, summary, file, line and diffstat', () => {
    const state = run([toolUse({ toolUseId: 't7', kind: 'Edit', summary: 'src/a.ts', file: '/p/src/a.ts', line: 12, diffstat: { added: 3, removed: 1 } })])
    expect(state.items).toEqual([
      { kind: 'tool', toolUseId: 't7', tool: 'Edit', summary: 'src/a.ts', file: '/p/src/a.ts', line: 12, diffstat: { added: 3, removed: 1 } },
    ])
  })

  test('with file updates modifiedFiles for Edit/Write kinds ONLY (Read does not)', () => {
    const state = run([
      toolUse({ toolUseId: 't1', kind: 'Edit', summary: 'a.ts', file: '/p/a.ts', line: 4, diffstat: { added: 2, removed: 1 } }),
      toolUse({ toolUseId: 't2', kind: 'Read', summary: 'b.ts', file: '/p/b.ts' }),
      toolUse({ toolUseId: 't3', kind: 'Write', summary: 'c.ts', file: '/p/c.ts', diffstat: { added: 5, removed: 0 } }),
    ])
    expect(state.modifiedFiles.get('/p/a.ts')).toEqual({ added: 2, removed: 1, lastLine: 4 })
    expect(state.modifiedFiles.get('/p/c.ts')).toEqual({ added: 5, removed: 0, lastLine: undefined })
    expect(state.modifiedFiles.has('/p/b.ts')).toBe(false)
  })

  test('repeated edits on the same file accumulate the diffstat and track the last line', () => {
    const state = run([
      toolUse({ toolUseId: 't1', kind: 'Edit', summary: 'a.ts', file: '/p/a.ts', line: 4, diffstat: { added: 2, removed: 1 } }),
      toolUse({ toolUseId: 't2', kind: 'Edit', summary: 'a.ts', file: '/p/a.ts', line: 30, diffstat: { added: 1, removed: 6 } }),
    ])
    expect(state.modifiedFiles.get('/p/a.ts')).toEqual({ added: 3, removed: 7, lastLine: 30 })
  })
})

describe('tool_result', () => {
  test('attaches to its toolUseId', () => {
    const state = run([
      toolUse({ toolUseId: 't1', summary: 'bun test' }),
      toolUse({ toolUseId: 't2', summary: 'git status' }),
      { type: 'tool_result', sessionId: S, toolUseId: 't1', ok: true, summary: '110 pass' },
    ])
    expect(state.items[0]).toMatchObject({ kind: 'tool', toolUseId: 't1', result: { ok: true, summary: '110 pass' } })
    expect(state.items[1]).toEqual({ kind: 'tool', toolUseId: 't2', tool: 'Bash', summary: 'git status' })
  })

  test('for an unknown toolUseId is ignored', () => {
    const before = run([toolUse({ toolUseId: 't1' })])
    const state = reduce(before, { type: 'tool_result', sessionId: S, toolUseId: 'nope', ok: false, summary: 'boom' })
    expect(state.items).toEqual(before.items)
  })
})

describe('permission_request', () => {
  test('appends a permission item', () => {
    const state = run([permission('req1')])
    expect(state.items).toEqual([
      { kind: 'permission', requestId: 'req1', toolName: 'Bash', rendered: 'git push origin main', proposedRule: { toolName: 'Bash', matcher: 'git push' } },
    ])
  })

  test('a duplicate permission_request (re-emit after reconnect) does NOT duplicate the item', () => {
    const state = run([permission('req1'), permission('req1')])
    expect(state.items).toHaveLength(1)
  })

  test('resolvePermission marks the matching item resolved', () => {
    const state = resolvePermission(run([permission('req1'), permission('req2')]), 'req2', 'always')
    expect(state.items[0]).toMatchObject({ requestId: 'req1' })
    expect(state.items[0]).not.toMatchObject({ resolved: expect.anything() })
    expect(state.items[1]).toMatchObject({ requestId: 'req2', resolved: 'always' })
  })
})

describe('question_request', () => {
  const QUESTION_EVENT = {
    type: 'question_request' as const,
    sessionId: S,
    requestId: 'q1',
    questions: [{ question: 'Quelle approche ?', header: 'Approche', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }],
  }

  test('question_request insère un item question et clôt le run de texte', () => {
    let state = reduce(initialState(), delta('hmm'))
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
})

describe('status', () => {
  test('idle marks streaming items done', () => {
    const state = run([delta('presque fini'), status({ state: 'idle' })])
    expect(state.items).toEqual([{ kind: 'assistant', text: 'presque fini', streaming: false }])
    expect(state.status).toBe('idle')
  })

  test('error fills error { reason, resetAt }', () => {
    const state = run([delta('…'), status({ state: 'error', error: { reason: 'rate_limited', resetAt: '2026-07-15T11:00:00.000Z' } })])
    expect(state.status).toBe('error')
    expect(state.error).toEqual({ reason: 'rate_limited', resetAt: '2026-07-15T11:00:00.000Z' })
    expect(state.items[0]).toMatchObject({ streaming: false })
  })

  test('mapping is ignored by the reducer — remap handling lives in the controller (onSessionRemapped)', () => {
    const state = reduce(initialState(), status({ state: 'streaming', mapping: { draftId: 'draft-1', sessionId: 'sdk-1' } }))
    expect(state.status).toBe('streaming')
    expect('remappedTo' in state).toBe(false)
  })
})

describe('usage', () => {
  test('is a no-op for the view-model (recorded server-side; the plan gauges are the only usage surface)', () => {
    const before = run([delta('a')])
    const after = reduce(before, { type: 'usage', sessionId: S, inputTokens: 100, outputTokens: 20, cacheReadTokens: 400, cacheCreationTokens: 50 })
    expect(after).toBe(before)
  })
})

describe('reset', () => {
  const history: ChatMessage[] = [
    { role: 'user', text: 'salut', at: AT },
    { role: 'assistant', text: 'bonjour', at: AT },
    { role: 'tool', toolUseId: 't9', kind: 'Edit', summary: 'src/a.ts', ok: true, file: '/p/src/a.ts', line: 12, diffstat: { added: 3, removed: 1 }, at: AT },
  ]

  test('maps ChatMessage[] (including the tool role with file/line/diffstat) to items', () => {
    const state = reset(history)
    expect(state.items).toEqual([
      { kind: 'user', text: 'salut' },
      { kind: 'assistant', text: 'bonjour', streaming: false },
      { kind: 'tool', toolUseId: 't9', tool: 'Edit', summary: 'src/a.ts', file: '/p/src/a.ts', line: 12, diffstat: { added: 3, removed: 1 }, result: { ok: true, summary: '' } },
    ])
    expect(state.status).toBe('idle')
  })

  test('rebuilds modifiedFiles from Edit/Write history tools (reconnect resync keeps the files panel)', () => {
    const state = reset(history)
    expect(state.modifiedFiles.get('/p/src/a.ts')).toEqual({ added: 3, removed: 1, lastLine: 12 })
  })

  test('a status with partialText right after reset seeds the in-flight assistant item', () => {
    const state = reduce(reset(history), status({ state: 'streaming', partialText: 'Je regarde le code…' }))
    expect(state.items.at(-1)).toEqual({ kind: 'assistant', text: 'Je regarde le code…', streaming: true })
    expect(state.status).toBe('streaming')
  })
})

describe('slash commands', () => {
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
})
