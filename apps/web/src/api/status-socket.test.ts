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
})
