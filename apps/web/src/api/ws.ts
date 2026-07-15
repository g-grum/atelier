import { isServerEvent, type ClientMessage, type ServerEvent } from '@atelier/shared'
import { getToken } from './client'

/**
 * Minimal structural slice of WebSocket used by SessionSocket — injectable in
 * tests. Handlers are property-assigned (no addEventListener) so a fake is a
 * plain class. `onerror` is deliberately absent: browsers always follow a
 * connection error with a `close` event, so reconnect logic hangs off onclose.
 */
export type SocketLike = {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
}

export type SocketFactory = (url: string) => SocketLike

/** Injectable timer: returns a cancel function (setTimeout/clearTimeout in production). */
export type Schedule = (fn: () => void, delayMs: number) => () => void

const INITIAL_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 4000

// Native WebSocket matches SocketLike at runtime (handlers receive Event /
// MessageEvent supersets of what SocketLike declares) but strictFunctionTypes
// rejects the handler-property variance — hence the one cast at this boundary.
const browserSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike

const timeoutSchedule: Schedule = (fn, delayMs) => {
  const id = setTimeout(fn, delayMs)
  return () => clearTimeout(id)
}

/**
 * Auto-reconnecting WebSocket to /api/sessions/:id/stream.
 *
 * - Backoff: 250ms doubling to a 4s cap, reset to 250ms on successful open.
 * - onReconnect fires on every re-open after a drop (never on the first open) —
 *   the controller re-fetches history there; the server's status snapshot +
 *   re-emitted permission_requests cover the rest of the resync.
 * - close() is app-level only: stops reconnecting. A bare socket drop never
 *   aborts the server-side turn; only the abort ClientMessage does.
 * - send() while the socket is down BUFFERS (flushed in order on the next
 *   open) rather than dropping: a user_message or permission_response typed
 *   during a connection blip must not be silently lost, and the server treats
 *   each ClientMessage independently so late delivery is safe.
 */
export class SessionSocket {
  private readonly url: string
  private readonly createSocket: SocketFactory
  private readonly schedule: Schedule
  private readonly handlers = new Set<(event: ServerEvent) => void>()
  private readonly reconnectHandlers = new Set<() => void>()
  private socket: SocketLike | null = null
  private outbox: string[] = []
  private backoffMs = INITIAL_BACKOFF_MS
  private isOpen = false
  private everOpened = false
  private closedByApp = false
  private cancelReconnect: (() => void) | null = null

  constructor(sessionId: string, projectId: string, options: { createSocket?: SocketFactory; schedule?: Schedule } = {}) {
    this.createSocket = options.createSocket ?? browserSocketFactory
    this.schedule = options.schedule ?? timeoutSchedule
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    this.url = `${scheme}://${location.host}/api/sessions/${encodeURIComponent(sessionId)}/stream?token=${encodeURIComponent(getToken())}&projectId=${encodeURIComponent(projectId)}`
    this.connect()
  }

  /** Register a handler for parsed ServerEvents. Returns an unsubscribe function. */
  on(handler: (event: ServerEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** Fired on every re-open after a drop — never on the first open. Returns an unsubscribe function. */
  onReconnect(callback: () => void): () => void {
    this.reconnectHandlers.add(callback)
    return () => this.reconnectHandlers.delete(callback)
  }

  send(message: ClientMessage): void {
    const data = JSON.stringify(message)
    if (this.isOpen && this.socket !== null) {
      this.socket.send(data)
    } else {
      this.outbox.push(data)
    }
  }

  /** App-level close: stops reconnecting. Never aborts the server-side turn. */
  close(): void {
    this.closedByApp = true
    this.cancelReconnect?.()
    this.cancelReconnect = null
    this.socket?.close()
  }

  private connect(): void {
    const socket = this.createSocket(this.url)
    this.socket = socket

    socket.onopen = () => {
      if (socket !== this.socket) return
      const isReconnect = this.everOpened
      this.everOpened = true
      this.isOpen = true
      this.backoffMs = INITIAL_BACKOFF_MS
      this.flushOutbox()
      if (isReconnect) for (const callback of this.reconnectHandlers) callback()
    }

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        return
      }
      if (!isServerEvent(parsed)) return
      for (const handler of this.handlers) handler(parsed)
    }

    socket.onclose = () => {
      if (socket !== this.socket) return
      this.isOpen = false
      if (this.closedByApp) return
      this.cancelReconnect = this.schedule(() => {
        this.cancelReconnect = null
        this.connect()
      }, this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    }
  }

  private flushOutbox(): void {
    if (this.socket === null) return
    const queued = this.outbox
    this.outbox = []
    for (const data of queued) this.socket.send(data)
  }
}
