import { describe, expect, test } from 'bun:test'
import type { ChatMessage, ClientMessage, ServerEvent } from '@atelier/shared'
import { SessionController, type ControllerSocket } from './session-controller'
import { FIXTURE_SESSION_ID, fixtureMessages, fixtureTurn } from './fixtures'

class FakeControllerSocket implements ControllerSocket {
  sent: ClientMessage[] = []
  closed = false
  private readonly handlers = new Set<(event: ServerEvent) => void>()
  private readonly reconnectHandlers = new Set<() => void>()

  on(handler: (event: ServerEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  onReconnect(callback: () => void): () => void {
    this.reconnectHandlers.add(callback)
    return () => this.reconnectHandlers.delete(callback)
  }

  send(message: ClientMessage): void {
    this.sent.push(message)
  }

  close(): void {
    this.closed = true
  }

  emit(event: ServerEvent): void {
    for (const handler of this.handlers) handler(event)
  }

  reconnect(): void {
    for (const callback of this.reconnectHandlers) callback()
  }
}

type PendingFetch = { sessionId: string; resolve: (history: ChatMessage[]) => void; reject: (error: unknown) => void }

function makeHarness() {
  const sockets: FakeControllerSocket[] = []
  const socketArgs: { sessionId: string; projectId: string }[] = []
  const fetches: PendingFetch[] = []
  const remaps: { draftId: string; sessionId: string }[] = []
  const controller = new SessionController({
    fetchMessages: (sessionId) =>
      new Promise<ChatMessage[]>((resolve, reject) => {
        fetches.push({ sessionId, resolve, reject })
      }),
    createSocket: (sessionId, projectId) => {
      socketArgs.push({ sessionId, projectId })
      const socket = new FakeControllerSocket()
      sockets.push(socket)
      return socket
    },
    onSessionRemapped: (mapping) => remaps.push(mapping),
  })
  const lastFetch = (): PendingFetch => {
    const pending = fetches.at(-1)
    if (pending === undefined) throw new Error('no fetch issued')
    return pending
  }
  const socket = (): FakeControllerSocket => {
    const fake = sockets.at(-1)
    if (fake === undefined) throw new Error('no socket created')
    return fake
  }
  /** open() with the fetch resolved immediately. */
  const open = async (history: ChatMessage[] = [], sessionId = 's1', projectId = 'p1'): Promise<void> => {
    const opened = controller.open(sessionId, projectId)
    lastFetch().resolve(history)
    await opened
  }
  return { controller, sockets, socketArgs, fetches, remaps, lastFetch, socket, open }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const history: ChatMessage[] = [
  { role: 'user', text: 'Bonjour', at: '2026-07-15T09:00:00.000Z' },
  { role: 'assistant', text: 'Salut !', at: '2026-07-15T09:00:05.000Z' },
]

const delta = (text: string): ServerEvent => ({ type: 'assistant_delta', sessionId: 's1', text })

describe('SessionController open', () => {
  test('fetches history, resets state, then connects the socket for that session', async () => {
    const { controller, fetches, sockets, socketArgs, lastFetch } = makeHarness()
    const opened = controller.open('s1', 'p1')
    expect(fetches.map((f) => f.sessionId)).toEqual(['s1'])
    expect(sockets).toHaveLength(0) // socket connects only after history landed

    lastFetch().resolve(history)
    await opened
    expect(controller.getState().items).toEqual([
      { kind: 'user', text: 'Bonjour' },
      { kind: 'assistant', text: 'Salut !', streaming: false },
    ])
    expect(socketArgs).toEqual([{ sessionId: 's1', projectId: 'p1' }])
  })

  test('live events reduce into the exposed state and notify subscribers', async () => {
    const { controller, socket, open } = makeHarness()
    await open(history)
    let notifications = 0
    controller.subscribe(() => notifications++)

    const before = controller.getState()
    socket().emit(delta('Je regarde'))
    expect(notifications).toBe(1)
    expect(controller.getState()).not.toBe(before)
    expect(controller.getState().items.at(-1)).toEqual({ kind: 'assistant', text: 'Je regarde', streaming: true })
    expect(controller.getState().status).toBe('streaming')
  })

  test('unsubscribe stops notifications', async () => {
    const { controller, socket, open } = makeHarness()
    await open()
    let notifications = 0
    const unsubscribe = controller.subscribe(() => notifications++)
    unsubscribe()
    socket().emit(delta('x'))
    expect(notifications).toBe(0)
  })

  test('rejects when the history fetch fails and connects no socket', async () => {
    const { controller, sockets, lastFetch } = makeHarness()
    const opened = controller.open('s1', 'p1')
    lastFetch().reject(new Error('boom'))
    await expect(opened).rejects.toThrow('boom')
    expect(sockets).toHaveLength(0)
  })

  test('opening another session closes the previous socket and clears the state', async () => {
    const { controller, sockets, socket, open } = makeHarness()
    await open(history, 's1')
    socket().emit(delta('en cours'))

    await open([], 's2', 'p1')
    expect(sockets[0]?.closed).toBe(true)
    expect(controller.getState().items).toEqual([])
  })

  test('a stale open fetch never clobbers a newer open', async () => {
    const { controller, fetches, socketArgs } = makeHarness()
    const openedA = controller.open('sA', 'p1')
    const openedB = controller.open('sB', 'p1')
    const fetchA = fetches[0]
    const fetchB = fetches[1]
    if (fetchA === undefined || fetchB === undefined) throw new Error('expected two fetches')

    fetchB.resolve([])
    await openedB
    fetchA.resolve(history) // stale — must be discarded
    await openedA

    expect(controller.getState().items).toEqual([])
    expect(socketArgs).toEqual([{ sessionId: 'sB', projectId: 'p1' }])
  })
})

describe('SessionController reconnect resync', () => {
  test('reconnect refetches history, resets, and applies snapshot events buffered during the refetch', async () => {
    const { controller, fetches, socket, lastFetch, open } = makeHarness()
    await open(history)
    socket().emit(delta('texte perdu pendant la coupure'))

    socket().reconnect()
    expect(fetches.map((f) => f.sessionId)).toEqual(['s1', 's1'])

    // The server sends its snapshot immediately on reconnect — before the
    // refetch resolves. Those events must be held, not applied to stale state.
    const beforeResync = controller.getState()
    socket().emit({ type: 'status', sessionId: 's1', state: 'streaming', partialText: 'Voici la suite complète' })
    socket().emit({
      type: 'permission_request',
      sessionId: 's1',
      requestId: 'req-1',
      toolName: 'Bash',
      rendered: 'git push origin main',
      proposedRule: { toolName: 'Bash', matcher: 'git push' },
    })
    expect(controller.getState()).toBe(beforeResync)

    const refetched: ChatMessage[] = [...history, { role: 'user', text: 'Continue', at: '2026-07-15T09:01:00.000Z' }]
    lastFetch().resolve(refetched)
    await flush()

    expect(controller.getState().items).toEqual([
      { kind: 'user', text: 'Bonjour' },
      { kind: 'assistant', text: 'Salut !', streaming: false },
      { kind: 'user', text: 'Continue' },
      // The re-emitted permission closes the text run (the turn is blocked on it).
      { kind: 'assistant', text: 'Voici la suite complète', streaming: false },
      { kind: 'permission', requestId: 'req-1', toolName: 'Bash', rendered: 'git push origin main', proposedRule: { toolName: 'Bash', matcher: 'git push' } },
    ])
    expect(controller.getState().status).toBe('streaming')
  })

  test('a failed resync fetch keeps the current state and still applies buffered events', async () => {
    const { controller, socket, lastFetch, open } = makeHarness()
    await open(history)

    socket().reconnect()
    socket().emit(delta('après la coupure'))
    lastFetch().reject(new Error('offline'))
    await flush()

    expect(controller.getState().items).toEqual([
      { kind: 'user', text: 'Bonjour' },
      { kind: 'assistant', text: 'Salut !', streaming: false },
      { kind: 'assistant', text: 'après la coupure', streaming: true },
    ])
  })
})

describe('SessionController draft remap', () => {
  test('mapping swaps the active id, fires the callback once, and subsequent refetches use the SDK id', async () => {
    const { controller, socket, remaps, lastFetch, open } = makeHarness()
    await open([], 'draft-1', 'p1')

    socket().emit({ type: 'status', sessionId: 'sdk-1', state: 'streaming', mapping: { draftId: 'draft-1', sessionId: 'sdk-1' } })
    expect(remaps).toEqual([{ draftId: 'draft-1', sessionId: 'sdk-1' }])

    // Further events must not re-fire the callback (remappedTo stays set in state).
    socket().emit({ type: 'assistant_delta', sessionId: 'sdk-1', text: 'ok' })
    socket().emit({ type: 'status', sessionId: 'sdk-1', state: 'idle' })
    expect(remaps).toHaveLength(1)

    socket().reconnect()
    expect(lastFetch().sessionId).toBe('sdk-1')
    lastFetch().resolve([])
    await flush()
    expect(controller.getState().items).toEqual([])
  })
})

describe('SessionController actions', () => {
  test('sendMessage sends user_message, appends a local user item, and reports acceptance', async () => {
    const { controller, socket, open } = makeHarness()
    await open(history)
    expect(controller.sendMessage('Continue le correctif')).toBe(true)
    expect(socket().sent).toEqual([{ type: 'user_message', text: 'Continue le correctif' }])
    expect(controller.getState().items.at(-1)).toEqual({ kind: 'user', text: 'Continue le correctif' })
  })

  test('sendMessage is refused mid-turn — the server drops it, so no phantom echo', async () => {
    const { controller, socket, open } = makeHarness()
    await open(history)
    socket().emit(delta('je travaille'))
    expect(controller.getState().status).toBe('streaming')

    const before = controller.getState()
    expect(controller.sendMessage('trop tôt')).toBe(false)
    expect(socket().sent).toEqual([]) // mirrors session-stream: mid-turn user_message is dropped
    expect(controller.getState()).toBe(before)

    // Once the turn ends the composer path reopens.
    socket().emit({ type: 'status', sessionId: 's1', state: 'idle' })
    expect(controller.sendMessage('maintenant oui')).toBe(true)
    expect(socket().sent).toEqual([{ type: 'user_message', text: 'maintenant oui' }])
    expect(controller.getState().items.at(-1)).toEqual({ kind: 'user', text: 'maintenant oui' })
  })

  test('sendMessage without an open socket is refused', () => {
    const controller = new SessionController()
    expect(controller.sendMessage('personne n’écoute')).toBe(false)
    expect(controller.getState().items).toEqual([])
  })

  test('respondPermission sends permission_response and resolves the item locally', async () => {
    const { controller, socket, open } = makeHarness()
    await open()
    socket().emit({
      type: 'permission_request',
      sessionId: 's1',
      requestId: 'req-9',
      toolName: 'Bash',
      rendered: 'rm -rf dist',
      proposedRule: null,
    })
    controller.respondPermission('req-9', 'allow')

    expect(socket().sent).toEqual([{ type: 'permission_response', requestId: 'req-9', decision: 'allow' }])
    const item = controller.getState().items.at(-1)
    expect(item).toMatchObject({ kind: 'permission', requestId: 'req-9', resolved: 'allow' })
  })

  test('abort sends the abort message (the only thing that stops a turn)', async () => {
    const { controller, socket, open } = makeHarness()
    await open()
    controller.abort()
    expect(socket().sent).toEqual([{ type: 'abort' }])
  })

  test('close closes the socket', async () => {
    const { controller, socket, open } = makeHarness()
    await open()
    controller.close()
    expect(socket().closed).toBe(true)
  })
})

describe('SessionController sendMessage vs resync', () => {
  test('sendMessage during a pending resync refetch is refused — the stale status cannot vouch for the server', async () => {
    const { controller, socket, lastFetch, open } = makeHarness()
    await open(history)

    socket().reconnect()
    const before = controller.getState()
    expect(controller.sendMessage('pendant le resync')).toBe(false)
    expect(socket().sent).toEqual([])
    expect(controller.getState()).toBe(before)

    lastFetch().resolve(history)
    await flush()
    expect(controller.sendMessage('après le resync')).toBe(true)
    expect(controller.getState().items.at(-1)).toEqual({ kind: 'user', text: 'après le resync' })
  })

  test('a local echo missing from the resync refetch survives the reset, then dedupes once persisted', async () => {
    const { controller, socket, lastFetch, open } = makeHarness()
    await open(history)
    expect(controller.sendMessage('Relance les tests')).toBe(true)

    // Socket blip: ws.ts flushes the outboxed user_message on reopen BEFORE
    // firing onReconnect, so the resync GET races the SDK's persistence and
    // misses the just-sent message. The accepted echo must not vanish.
    socket().reconnect()
    lastFetch().resolve(history) // refetched history predates the message
    await flush()
    expect(controller.getState().items).toEqual([
      { kind: 'user', text: 'Bonjour' },
      { kind: 'assistant', text: 'Salut !', streaming: false },
      { kind: 'user', text: 'Relance les tests' }, // replayed — sendMessage's `true` must not lie
    ])

    // A later resync sees the persisted copy — confirmed, not doubled.
    socket().reconnect()
    lastFetch().resolve([...history, { role: 'user', text: 'Relance les tests', at: '2026-07-15T09:02:00.000Z' }])
    await flush()
    expect(controller.getState().items).toEqual([
      { kind: 'user', text: 'Bonjour' },
      { kind: 'assistant', text: 'Salut !', streaming: false },
      { kind: 'user', text: 'Relance les tests' },
    ])
  })

  test('echo replay counts occurrences — an old message with the same text does not confirm a new echo', async () => {
    const repeatHistory: ChatMessage[] = [
      ...history,
      { role: 'user', text: 'Continue', at: '2026-07-15T09:01:00.000Z' },
      { role: 'assistant', text: 'Fait.', at: '2026-07-15T09:01:30.000Z' },
    ]
    const { controller, socket, lastFetch, open } = makeHarness()
    await open(repeatHistory)
    expect(controller.sendMessage('Continue')).toBe(true)

    socket().reconnect()
    lastFetch().resolve(repeatHistory) // still only the OLD « Continue »
    await flush()

    expect(controller.getState().items.filter((item) => item.kind === 'user')).toEqual([
      { kind: 'user', text: 'Bonjour' },
      { kind: 'user', text: 'Continue' },
      { kind: 'user', text: 'Continue' }, // the new echo survives
    ])
  })

  test('pending echoes do not leak across open() — a new session resync cannot replay them', async () => {
    const { controller, socket, lastFetch, open } = makeHarness()
    await open(history, 's1')
    expect(controller.sendMessage('message pour s1')).toBe(true)

    await open([], 's2', 'p1')
    socket().reconnect()
    lastFetch().resolve([])
    await flush()
    expect(controller.getState().items).toEqual([])
  })
})

describe('fixtures', () => {
  test('the scripted fixture turn replays through the controller', async () => {
    const { controller, socket, open } = makeHarness()
    const fixtureHistory = fixtureMessages[FIXTURE_SESSION_ID]
    if (fixtureHistory === undefined) throw new Error('fixture history missing')
    await open(fixtureHistory, FIXTURE_SESSION_ID, 'p1')

    for (const event of fixtureTurn) socket().emit(event)

    const state = controller.getState()
    expect(state.status).toBe('idle')
    expect(state.items.some((item) => item.kind === 'tool' && item.tool === 'Bash' && item.result?.ok === true)).toBe(true)
    expect(state.items.some((item) => item.kind === 'permission')).toBe(true)
    expect(state.sessionTokens.input).toBeGreaterThan(0)
    expect(state.sessionTokens.output).toBeGreaterThan(0)
    // The turn ended — no assistant item is left streaming.
    expect(state.items.some((item) => item.kind === 'assistant' && item.streaming)).toBe(false)
  })
})
