import { describe, expect, it } from 'bun:test'
import { StatusSocket } from './status-socket'
import type { SocketLike } from './ws'

function fakeSocket() {
  const s: SocketLike & { emitOpen: () => void; emitMessage: (d: unknown) => void; emitClose: () => void; closed: boolean } = {
    onopen: null, onmessage: null, onclose: null, closed: false,
    send() {}, close() { this.closed = true },
    emitOpen() { this.onopen?.() },
    emitMessage(d) { this.onmessage?.({ data: JSON.stringify(d) }) },
    emitClose() { this.onclose?.() },
  }
  return s
}

describe('StatusSocket', () => {
  it('parse et transmet les session_status', () => {
    const sock = fakeSocket()
    const seen: unknown[] = []
    new StatusSocket((e) => seen.push(e), { createSocket: () => sock, schedule: (fn) => { void fn; return () => {} } })
    sock.emitOpen()
    sock.emitMessage({ type: 'session_status', sessionId: 'a', state: 'streaming' })
    sock.emitMessage({ type: 'garbage' })
    expect(seen).toEqual([{ type: 'session_status', sessionId: 'a', state: 'streaming' }])
  })

  it('se reconnecte après une fermeture non voulue', () => {
    const sockA = fakeSocket()
    const sockB = fakeSocket()
    const socks = [sockA, sockB]
    let built = 0
    const run: Array<() => void> = []
    new StatusSocket(() => {}, { createSocket: () => socks[built++] ?? sockB, schedule: (fn) => { run.push(fn); return () => {} } })
    sockA.emitOpen()
    sockA.emitClose()      // drop → schedule a reconnect
    run.forEach((fn) => fn()) // run the timer
    expect(built).toBe(2)
  })

  it('close() annule une reconnexion en attente', () => {
    const sockA = fakeSocket()
    const sockB = fakeSocket()
    const socks = [sockA, sockB]
    let built = 0
    // Timer list honoring cancellation, like ws.test.ts's makeScheduler.
    const pending: Array<{ fn: () => void; cancelled: boolean }> = []
    const status = new StatusSocket(() => {}, {
      createSocket: () => socks[built++] ?? sockB,
      schedule: (fn) => {
        const timer = { fn, cancelled: false }
        pending.push(timer)
        return () => { timer.cancelled = true }
      },
    })
    sockA.emitOpen()
    sockA.emitClose()        // drop → schedule a reconnect
    status.close()           // cancels the pending timer
    expect(pending[0]?.cancelled).toBe(true)
    for (const timer of pending) if (!timer.cancelled) timer.fn()
    expect(built).toBe(1)    // no reconnect: timer was cancelled
    expect(sockA.closed).toBe(true)
  })

  it('does not close a socket whose handshake is still in flight', () => {
    const sock = fakeSocket()
    const status = new StatusSocket(() => {}, { createSocket: () => sock, schedule: (fn) => { void fn; return () => {} } })
    // React StrictMode mounts, cleans up, then mounts again — synchronously, so
    // close() lands while the socket is still CONNECTING. Closing there makes the
    // browser log "WebSocket is closed before the connection is established".
    status.close()
    expect(sock.closed).toBe(false)
    // The handshake completes anyway: close it then, as soon as that is legal.
    sock.emitOpen()
    expect(sock.closed).toBe(true)
  })

  it('does not reconnect after a deferred close', () => {
    const socks = [fakeSocket(), fakeSocket()]
    let built = 0
    const run: Array<() => void> = []
    const status = new StatusSocket(() => {}, {
      createSocket: () => socks[built++] ?? socks[1]!,
      schedule: (fn) => { run.push(fn); return () => {} },
    })
    status.close()           // still CONNECTING
    socks[0]!.emitOpen()     // deferred close fires here
    socks[0]!.emitClose()    // browser follows with onclose
    run.forEach((fn) => fn())
    expect(built).toBe(1)
  })

  it('closes a socket that already settled', () => {
    const sock = fakeSocket()
    const status = new StatusSocket(() => {}, { createSocket: () => sock, schedule: (fn) => { void fn; return () => {} } })
    sock.emitOpen()
    status.close()
    expect(sock.closed).toBe(true)
  })

  it('ne se reconnecte pas si onclose arrive après close()', () => {
    const sockA = fakeSocket()
    const sockB = fakeSocket()
    const socks = [sockA, sockB]
    let built = 0
    const run: Array<() => void> = []
    const status = new StatusSocket(() => {}, {
      createSocket: () => socks[built++] ?? sockB,
      schedule: (fn) => { run.push(fn); return () => {} },
    })
    sockA.emitOpen()
    status.close()           // app-level close
    sockA.emitClose()        // browser fires onclose afterwards
    run.forEach((fn) => fn())
    expect(built).toBe(1)    // closedByApp short-circuits onclose
  })
})
