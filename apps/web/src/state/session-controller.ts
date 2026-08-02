import type { ChatMessage, PermissionDecision, RateLimitSnapshot, ServerEvent } from '@atelier/shared'
import { getMessages } from '../api/client'
import { SessionSocket } from '../api/ws'
import { initialState, reduce, reset, resolvePermission, resolveQuestion, type StreamState } from './stream-reducer'

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
  /** Fired on every live rate_limit event — app-global plan data (the UI feeds its query cache). */
  onRateLimit?: (limit: RateLimitSnapshot) => void
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
  private readonly onRateLimit: ((limit: RateLimitSnapshot) => void) | undefined
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
  /**
   * Messages accepted mid-turn, waiting for the server to go idle. The server
   * DROPS a mid-turn user_message (one turn at a time), so the client holds
   * them here and sends exactly one per idle transition (FIFO). Their display
   * items carry `queued: true` until they actually hit the socket.
   */
  private queue: string[] = []

  constructor(options: SessionControllerOptions = {}) {
    this.fetchMessages = options.fetchMessages ?? getMessages
    this.createSocket = options.createSocket ?? ((sessionId, projectId) => new SessionSocket(sessionId, projectId))
    this.onSessionRemapped = options.onSessionRemapped
    this.onRateLimit = options.onRateLimit
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
   * Returns whether the message was accepted. Refused only without a socket or
   * while a resync refetch is pending (the stale local status cannot vouch for
   * the server, and the imminent reset would race the echo). Mid-turn sends
   * are ACCEPTED and queued: the server drops a mid-turn user_message (one
   * turn at a time), so the queue holds them and pump() sends exactly one per
   * idle transition.
   *
   * An actual send flips status to 'streaming' immediately (in pump),
   * mirroring the server's synchronous transition on user_message
   * (session-stream flips before the first delta). Without it, the
   * time-to-first-token window would let a second message hit the socket and
   * be dropped server-side, making the local echo a phantom.
   */
  sendMessage(text: string): boolean {
    if (this.socket === null || this.resyncing) return false
    // Taper un message pendant un QCM = y répondre en texte : dismiss d'abord
    // (le deny dénoue le tour côté serveur), le message part au prochain idle.
    this.dismissPendingQuestions()
    this.queue.push(text)
    this.setState({ ...this.state, items: [...this.state.items, { kind: 'user', text, queued: true }] })
    this.pump()
    return true
  }

  /** Sends the oldest queued message iff the session is free — called on accept and on every idle settle. */
  private pump(): void {
    if (this.socket === null || this.resyncing || this.state.status === 'streaming') return
    const text = this.queue.shift()
    if (text === undefined) return
    this.socket.send({ type: 'user_message', text })
    // The server never echoes user messages as ServerEvents — the queued item
    // becomes the local echo (the persisted copy comes back on the next fetch).
    this.pendingEchoes.push(text)
    let sent = false
    const items = this.state.items.map((item) => {
      if (!sent && item.kind === 'user' && item.queued === true) {
        sent = true
        return { kind: 'user' as const, text: item.text }
      }
      return item
    })
    this.setState({ ...this.state, status: 'streaming', items })
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    if (this.socket === null) return
    this.socket.send({ type: 'permission_response', requestId, decision })
    this.setState(resolvePermission(this.state, requestId, decision))
  }

  answerQuestion(requestId: string, answers: Record<string, string>): void {
    if (this.socket === null) return
    this.socket.send({ type: 'question_response', requestId, answers })
    this.setState(resolveQuestion(this.state, requestId, answers))
  }

  /** Dismiss (answers ABSENT sur le fil) de tous les QCM pendants — « répondu en texte ». */
  private dismissPendingQuestions(): void {
    let state = this.state
    for (const item of this.state.items) {
      if (item.kind === 'question' && item.resolved === undefined) {
        this.socket?.send({ type: 'question_response', requestId: item.requestId })
        state = resolveQuestion(state, item.requestId, undefined)
      }
    }
    if (state !== this.state) this.setState(state)
  }

  /**
   * The only thing that stops a turn — a bare socket close never aborts.
   * Stop stops EVERYTHING: the queue is dropped too, otherwise the idle
   * settle right after the abort would auto-send the next queued message.
   */
  abort(): void {
    this.socket?.send({ type: 'abort' })
    if (this.queue.length > 0) {
      this.queue = []
      this.setState({ ...this.state, items: this.state.items.filter((item) => !(item.kind === 'user' && item.queued === true)) })
    }
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
    this.queue = []
  }

  private receive(event: ServerEvent): void {
    if (this.resyncing) {
      this.buffer.push(event)
      return
    }
    this.apply(event)
  }

  private apply(event: ServerEvent): void {
    if (event.type === 'rate_limit') {
      // App-global — bypasses the per-session reducer entirely.
      this.onRateLimit?.(event.limit)
      return
    }
    this.setState(reduce(this.state, event))
    if (event.type === 'status' && event.mapping !== undefined && event.mapping.sessionId !== this.activeSessionId) {
      this.activeSessionId = event.mapping.sessionId
      this.onSessionRemapped?.(event.mapping)
    }
    // The turn is over — the session is free for the next queued message.
    // Deliberately NOT on 'error': auto-resending into a failing session would
    // burn the queue; the user's next explicit send re-pumps it (FIFO intact).
    if (event.type === 'status' && event.state === 'idle') this.pump()
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
      // Queued messages were never sent — no history can account for them.
      // Re-append their display after the reset; the queue itself survived.
      for (const text of this.queue) next.items.push({ kind: 'user', text, queued: true })
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
    // Queued items were never sent — they cannot be "confirmed on screen" and
    // must not consume the budget of an identical pending echo.
    for (const item of this.state.items) if (item.kind === 'user' && item.queued !== true) bump(item.text, -1)
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
