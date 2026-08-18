import { parseStatusHubEvent, type StatusHubEvent } from '@atelier/shared'
import { getToken } from './client'
import type { Schedule, SocketFactory, SocketLike } from './ws'

const INITIAL_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 4000

const browserSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike
const timeoutSchedule: Schedule = (fn, delayMs) => {
  const id = setTimeout(fn, delayMs)
  return () => clearTimeout(id)
}

/**
 * WS receive-only vers /api/sessions-status. Auto-reconnexion (250ms→4s).
 * À chaque (re)connexion le serveur renvoie le snapshot complet, donc aucune
 * logique de resync ici. `close()` stoppe la reconnexion (démontage React).
 */
export class StatusSocket {
  private readonly url: string
  private readonly createSocket: SocketFactory
  private readonly schedule: Schedule
  private socket: SocketLike | null = null
  private backoffMs = INITIAL_BACKOFF_MS
  private closedByApp = false
  private cancelReconnect: (() => void) | null = null
  // Whether the current socket's handshake has settled (onopen or onclose fired).
  // Closing a socket that is still CONNECTING is legal but makes the browser log
  // "WebSocket is closed before the connection is established", so close() waits.
  private settled = false

  constructor(
    private readonly onEvent: (event: StatusHubEvent) => void,
    options: { createSocket?: SocketFactory; schedule?: Schedule } = {}
  ) {
    this.createSocket = options.createSocket ?? browserSocketFactory
    this.schedule = options.schedule ?? timeoutSchedule
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    this.url = `${scheme}://${location.host}/api/sessions-status?token=${encodeURIComponent(getToken())}`
    this.connect()
  }

  close(): void {
    this.closedByApp = true
    this.cancelReconnect?.()
    this.cancelReconnect = null
    // Mid-handshake, onopen closes it instead — see `settled`.
    if (this.settled) this.socket?.close()
  }

  private connect(): void {
    const socket = this.createSocket(this.url)
    this.socket = socket
    this.settled = false
    socket.onopen = () => {
      if (socket !== this.socket) return
      this.settled = true
      // close() was called while connecting: honour it now that closing is clean.
      if (this.closedByApp) {
        socket.close()
        return
      }
      this.backoffMs = INITIAL_BACKOFF_MS
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const parsed = parseStatusHubEvent(event.data)
      if (parsed !== null) this.onEvent(parsed)
    }
    socket.onclose = () => {
      if (socket !== this.socket) return
      this.settled = true
      if (this.closedByApp) return
      this.cancelReconnect = this.schedule(() => {
        this.cancelReconnect = null
        this.connect()
      }, this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    }
  }
}
