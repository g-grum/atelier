import { describe, expect, test } from 'bun:test'
import type { ClientMessage, ServerEvent } from '@atelier/shared'
import { SessionSocket, type SocketLike } from './ws'

class FakeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }
}

/** Deterministic scheduler: captures delays, fires timers manually, honors cancellation. */
function makeScheduler() {
  const delays: number[] = []
  const pending: { fn: () => void; cancelled: boolean }[] = []
  const schedule = (fn: () => void, delayMs: number): (() => void) => {
    delays.push(delayMs)
    const timer = { fn, cancelled: false }
    pending.push(timer)
    return () => {
      timer.cancelled = true
    }
  }
  const fireNext = (): boolean => {
    const timer = pending.shift()
    if (timer === undefined || timer.cancelled) return false
    timer.fn()
    return true
  }
  return { delays, pending, schedule, fireNext }
}

function makeHarness() {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const scheduler = makeScheduler()
  const socket = new SessionSocket('s1', 'p1', {
    createSocket: (url) => {
      urls.push(url)
      const fake = new FakeSocket()
      sockets.push(fake)
      return fake
    },
    schedule: scheduler.schedule,
  })
  const current = (): FakeSocket => {
    const fake = sockets.at(-1)
    if (fake === undefined) throw new Error('no socket created')
    return fake
  }
  return { socket, sockets, urls, scheduler, current }
}

const statusEvent: ServerEvent = { type: 'status', sessionId: 's1', state: 'idle' }
const userMessage: ClientMessage = { type: 'user_message', text: 'salut' }

describe('SessionSocket URL', () => {
  test('connects immediately to the stream endpoint with token and projectId', () => {
    const { urls } = makeHarness()
    expect(urls).toHaveLength(1)
    const url = urls[0] as string
    expect(url.startsWith('ws://') || url.startsWith('wss://')).toBe(true)
    expect(url).toContain('/api/sessions/s1/stream?')
    expect(url).toContain('token=')
    expect(url).toContain('projectId=p1')
  })
})

describe('SessionSocket backoff', () => {
  test('doubles 250 → 4000 cap across consecutive failures, resets to 250 after a successful open', () => {
    const { scheduler, current } = makeHarness()
    current().onopen?.()

    // Drop, then fail every reconnect attempt: 250, 500, 1000, 2000, 4000, 4000 (cap)
    current().onclose?.()
    for (let i = 0; i < 5; i++) {
      expect(scheduler.fireNext()).toBe(true)
      current().onclose?.()
    }
    expect(scheduler.delays).toEqual([250, 500, 1000, 2000, 4000, 4000])

    // A successful open resets the backoff to 250
    expect(scheduler.fireNext()).toBe(true)
    current().onopen?.()
    current().onclose?.()
    expect(scheduler.delays).toEqual([250, 500, 1000, 2000, 4000, 4000, 250])
  })

  test('reconnects with backoff even when the first connect never opens', () => {
    const { scheduler, sockets, current } = makeHarness()
    current().onclose?.()
    expect(scheduler.delays).toEqual([250])
    expect(scheduler.fireNext()).toBe(true)
    expect(sockets).toHaveLength(2)
  })
})

describe('SessionSocket onReconnect', () => {
  test('onReconnect fires on re-open after a drop, not on the first open', () => {
    const { socket, scheduler, current } = makeHarness()
    let reconnects = 0
    socket.onReconnect(() => {
      reconnects++
    })

    current().onopen?.()
    expect(reconnects).toBe(0)

    current().onclose?.()
    scheduler.fireNext()
    current().onopen?.()
    expect(reconnects).toBe(1)

    current().onclose?.()
    scheduler.fireNext()
    current().onopen?.()
    expect(reconnects).toBe(2)
  })
})

describe('SessionSocket close()', () => {
  test('does not close a socket whose handshake is still in flight', () => {
    const { socket, current } = makeHarness()
    // close() before onopen — the StrictMode double-mount case. Closing a
    // CONNECTING socket makes the browser log a warning, so defer it.
    socket.close()
    expect(current().closed).toBe(false)
    current().onopen?.()
    expect(current().closed).toBe(true)
  })

  test('a deferred close flushes nothing and never reconnects', () => {
    const { socket, scheduler, sockets, current } = makeHarness()
    socket.send(userMessage)   // buffered while still connecting
    socket.close()
    current().onopen?.()       // deferred close lands here
    expect(current().closed).toBe(true)
    expect(current().sent).toEqual([])  // app is gone: do not flush the outbox
    current().onclose?.()
    expect(scheduler.delays).toEqual([])
    expect(sockets).toHaveLength(1)
  })

  test('closes the underlying socket and never reconnects', () => {
    const { socket, scheduler, sockets, current } = makeHarness()
    current().onopen?.()
    socket.close()
    expect(current().closed).toBe(true)

    // The browser fires onclose after close() — must not schedule a reconnect
    current().onclose?.()
    expect(scheduler.delays).toEqual([])
    expect(sockets).toHaveLength(1)
  })

  test('cancels a pending reconnect timer', () => {
    const { socket, scheduler, sockets, current } = makeHarness()
    current().onopen?.()
    current().onclose?.()
    expect(scheduler.delays).toEqual([250])

    socket.close()
    expect(scheduler.fireNext()).toBe(false) // timer cancelled
    expect(sockets).toHaveLength(1)
  })
})

describe('SessionSocket send', () => {
  test('sends immediately while open', () => {
    const { socket, current } = makeHarness()
    current().onopen?.()
    socket.send(userMessage)
    expect(current().sent).toEqual([JSON.stringify(userMessage)])
  })

  test('buffers while not yet open and flushes in order on open', () => {
    const { socket, current } = makeHarness()
    socket.send(userMessage)
    socket.send({ type: 'abort' })
    expect(current().sent).toEqual([])

    current().onopen?.()
    expect(current().sent).toEqual([JSON.stringify(userMessage), JSON.stringify({ type: 'abort' })])
  })

  test('buffers during a reconnect gap and flushes on the new socket', () => {
    const { socket, scheduler, sockets, current } = makeHarness()
    current().onopen?.()
    current().onclose?.()

    socket.send(userMessage)
    expect(current().sent).toEqual([])

    scheduler.fireNext()
    current().onopen?.()
    expect(sockets).toHaveLength(2)
    expect(current().sent).toEqual([JSON.stringify(userMessage)])
    expect(sockets[0]?.sent).toEqual([])
  })
})

describe('SessionSocket on()', () => {
  test('delivers parsed ServerEvents to handlers', () => {
    const { socket, current } = makeHarness()
    const received: ServerEvent[] = []
    socket.on((event) => received.push(event))

    current().onopen?.()
    current().onmessage?.({ data: JSON.stringify(statusEvent) })
    expect(received).toEqual([statusEvent])
  })

  test('ignores malformed frames and unknown event types', () => {
    const { socket, current } = makeHarness()
    const received: ServerEvent[] = []
    socket.on((event) => received.push(event))

    current().onopen?.()
    current().onmessage?.({ data: 'not json{' })
    current().onmessage?.({ data: JSON.stringify({ type: 'mystery' }) })
    current().onmessage?.({ data: 42 })
    expect(received).toEqual([])
  })

  test('on() returns an unsubscribe function', () => {
    const { socket, current } = makeHarness()
    const received: ServerEvent[] = []
    const off = socket.on((event) => received.push(event))

    current().onopen?.()
    off()
    current().onmessage?.({ data: JSON.stringify(statusEvent) })
    expect(received).toEqual([])
  })
})
