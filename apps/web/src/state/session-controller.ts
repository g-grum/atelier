import type { ChatMessage, ServerEvent } from '@atelier/shared'
import { getMessages } from '../api/client'
import { SessionSocket } from '../api/ws'
import { initialState, reduce, reset, resolvePermission, type StreamState } from './stream-reducer'

/** The slice of SessionSocket the controller consumes — injectable in tests. */
export type ControllerSocket = Pick<SessionSocket, 'on' | 'onReconnect' | 'send' | 'close'>

export type SessionControllerOptions = {
  fetchMessages?: (sessionId: string) => Promise<ChatMessage[]>
  createSocket?: (sessionId: string, projectId: string) => ControllerSocket
  /**
   * Fired when a draft materializes into a real SDK session: the UI re-keys its
   * selected id and invalidates the sessions query (react-query invalidation).
   */
  onSessionRemapped?: (mapping: { draftId: string; sessionId: string }) => void
}

/**
 * Owns the session lifecycle (open / live events / resync / draft remap) so the
 * React layer stays declarative: `subscribe` + `getState` plug directly into
 * `useSyncExternalStore`.
 *
 * Resync path (spec): on reconnect, deltas missed during the gap are recovered
 * by re-fetching history; the server's snapshot (partialText + re-emitted
 * permission_requests) arrives on the socket BEFORE the refetch resolves, so
 * those events are buffered and replayed on top of the fresh `reset`.
 */
export class SessionController {
  private readonly fetchMessages: (sessionId: string) => Promise<ChatMessage[]>
  private readonly createSocket: (sessionId: string, projectId: string) => ControllerSocket
  private readonly onSessionRemapped: ((mapping: { draftId: string; sessionId: string }) => void) | undefined
  private readonly listeners = new Set<() => void>()
  private state: StreamState = initialState()
  private socket: ControllerSocket | null = null
  private activeSessionId: string | null = null
  /** Bumped on every open()/close() — stale open fetches bail on mismatch. */
  private openGeneration = 0
  /** Bumped on every resync — only the latest resync's refetch resets + flushes. */
  private resyncGeneration = 0
  private resyncing = false
  private buffer: ServerEvent[] = []
  /** User texts echoed locally but not yet seen in a fetched history — resync resets must not wipe them. */
  private pendingEchoes: string[] = []

  constructor(options: SessionControllerOptions = {}) {
    this.fetchMessages = options.fetchMessages ?? getMessages
    this.createSocket = options.createSocket ?? ((sessionId, projectId) => new SessionSocket(sessionId, projectId))
    this.onSessionRemapped = options.onSessionRemapped
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): StreamState {
    return this.state
  }

  /** History first, socket second — live events can never race the initial reset. */
  async open(sessionId: string, projectId: string): Promise<void> {
    this.close()
    const generation = this.openGeneration // close() already bumped it
    this.activeSessionId = sessionId
    this.setState(initialState())

    const history = await this.fetchMessages(sessionId)
    if (generation !== this.openGeneration) return // a newer open()/close() won
    this.setState(reset(history))

    const socket = this.createSocket(sessionId, projectId)
    this.socket = socket
    socket.on((event) => {
      if (this.socket === socket) this.receive(event)
    })
    socket.onReconnect(() => {
      if (this.socket === socket) void this.resync(socket)
    })
  }

  /**
   * Returns whether the message was accepted. Refused mid-turn (the server
   * drops user_message while streaming — one turn at a time) and while a
   * resync refetch is pending (the stale local status cannot vouch for the
   * server, and the imminent reset would race the echo). The UI gates the
   * composer on this contract. Once accepted, the local echo is guaranteed to
   * survive resync resets — see unconfirmedEchoes.
   *
   * An accepted send flips status to 'streaming' immediately, mirroring the
   * server's synchronous transition on user_message (session-stream flips
   * before the first delta). Without it, the time-to-first-token window keeps
   * local status 'idle' and a double-send would echo a message the server
   * drops. It also gates the composer and enables abort right away; the turn's
   * terminal status event (idle/error) restores it.
   */
  sendMessage(text: string): boolean {
    if (this.socket === null || this.resyncing || this.state.status === 'streaming') return false
    this.socket.send({ type: 'user_message', text })
    // The server never echoes user messages as ServerEvents — append locally
    // (the persisted copy comes back on the next history fetch).
    this.pendingEchoes.push(text)
    this.setState({ ...this.state, status: 'streaming', items: [...this.state.items, { kind: 'user', text }] })
    return true
  }

  respondPermission(requestId: string, decision: 'allow' | 'deny' | 'always'): void {
    if (this.socket === null) return
    this.socket.send({ type: 'permission_response', requestId, decision })
    this.setState(resolvePermission(this.state, requestId, decision))
  }

  /** The only thing that stops a turn — a bare socket close never aborts. */
  abort(): void {
    this.socket?.send({ type: 'abort' })
  }

  /** App-level close: drops the socket (the server-side turn keeps running). */
  close(): void {
    this.openGeneration++
    this.socket?.close()
    this.socket = null
    this.activeSessionId = null
    this.resyncing = false
    this.buffer = []
    this.pendingEchoes = []
  }

  private receive(event: ServerEvent): void {
    if (this.resyncing) {
      this.buffer.push(event)
      return
    }
    this.apply(event)
  }

  private apply(event: ServerEvent): void {
    this.setState(reduce(this.state, event))
    if (event.type === 'status' && event.mapping !== undefined && event.mapping.sessionId !== this.activeSessionId) {
      this.activeSessionId = event.mapping.sessionId
      this.onSessionRemapped?.(event.mapping)
    }
  }

  private async resync(socket: ControllerSocket): Promise<void> {
    const sessionId = this.activeSessionId
    if (sessionId === null) return
    const generation = ++this.resyncGeneration
    this.resyncing = true

    let history: ChatMessage[] | null = null
    try {
      history = await this.fetchMessages(sessionId)
    } catch {
      // Keep the stale state — live events still apply, the next reconnect retries.
    }
    if (generation !== this.resyncGeneration || socket !== this.socket) return

    this.resyncing = false
    const buffered = this.buffer
    this.buffer = []
    if (history !== null) {
      // The refetch can predate an accepted send: ws.ts flushes its outbox on
      // reopen BEFORE firing onReconnect, so the GET races the SDK's transcript
      // persistence. Re-append the echoes the history does not account for —
      // an accepted message must never silently vanish from the transcript.
      const missing = this.unconfirmedEchoes(history) // computed against the pre-reset items
      this.pendingEchoes = missing
      const next = reset(history)
      for (const text of missing) next.items.push({ kind: 'user', text })
      this.setState(next)
    }
    for (const event of buffered) this.apply(event)
  }

  /**
   * Multiset diff: which pending echoes does `history` NOT account for?
   * Budget per text = occurrences in the refetched history minus occurrences
   * already confirmed on screen (user items minus the pending echoes) — so a
   * repeated text (« Continue ») is never confirmed against an old message.
   * Pending echoes then consume the remaining budget in send order.
   */
  private unconfirmedEchoes(history: ChatMessage[]): string[] {
    if (this.pendingEchoes.length === 0) return []
    const budget = new Map<string, number>()
    const bump = (text: string, by: number): void => {
      budget.set(text, (budget.get(text) ?? 0) + by)
    }
    for (const message of history) if (message.role === 'user') bump(message.text, 1)
    for (const item of this.state.items) if (item.kind === 'user') bump(item.text, -1)
    for (const text of this.pendingEchoes) bump(text, 1)
    return this.pendingEchoes.filter((text) => {
      const remaining = budget.get(text) ?? 0
      bump(text, -1)
      return remaining <= 0 // no persisted copy left to match — still pending
    })
  }

  private setState(next: StreamState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
