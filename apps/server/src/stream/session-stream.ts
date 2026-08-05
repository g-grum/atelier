import type { PermissionRequest, QuestionRequest, ServerEvent, SessionState, SessionStatusEvent, StatusHubEvent } from '@atelier/shared'
import { parseClientMessage } from '@atelier/shared'
import type { SdkClient, SdkTurnEvent } from '../sdk/sdk-client'
import type { AppData } from '../store/app-data'
import { describeToolUse } from './describe-tool-use'
import { PermissionBroker } from './permission-broker'
import { QuestionBroker } from './question-broker'

export type EventSink = (event: ServerEvent) => void

type SessionStreamParams = {
  /** The id the client connected with — a draft id or an SDK session id. */
  id: string
  projectId: string
  data: AppData
  sdk: SdkClient
  /** Called when a draft materializes so the registry can re-key its singleton. */
  onRekey?: (from: string, to: string) => void
  /** Notifié à CHAQUE transition d'état (démarrage de tour inclus) — alimente le status hub. */
  onStatusChange?: (sessionId: string, state: SessionState) => void
}

/**
 * One live session: fans ServerEvents out to every connected socket, buffers the
 * in-flight turn for reconnect snapshots, and bridges permissions via the broker.
 * Socket-free by design — the WS route is glue around onConnect/onMessage/onClose.
 */
export class SessionStream {
  private readonly id: string
  private readonly projectId: string
  private readonly data: AppData
  private readonly sdk: SdkClient
  private readonly onRekey?: (from: string, to: string) => void
  private readonly onStatusChange?: (sessionId: string, state: SessionState) => void
  private readonly broker: PermissionBroker
  private readonly questions: QuestionBroker

  private readonly sinks = new Set<EventSink>()
  private state: SessionState = 'idle'
  /** Buffer of the current in-flight assistant text run — snapshot fodder for reconnects. */
  private partialText = ''
  /** tool_use supprimés du broadcast (QCM) — leurs tool_result doivent l'être aussi. */
  private readonly suppressedToolUseIds = new Set<string>()
  private lastError?: { reason: string; resetAt?: string }
  private turnAbort: AbortController | null = null
  /** Draft name awaiting renameSession — applied at turn end, once the SDK CLI has flushed the session JSONL. */
  private pendingRename: { sessionId: string; name: string } | null = null

  constructor({ id, projectId, data, sdk, onRekey, onStatusChange }: SessionStreamParams) {
    this.id = id
    this.projectId = projectId
    this.data = data
    this.sdk = sdk
    this.onRekey = onRekey
    this.onStatusChange = onStatusChange
    const projectDir = data.get().projects.find((p) => p.id === projectId)?.path ?? ''
    this.broker = new PermissionBroker(data, projectId, projectDir, (request) => {
      this.broadcast(this.toPermissionEvent(request))
    })
    this.questions = new QuestionBroker((request) => {
      this.broadcast(this.toQuestionEvent(request))
    })
  }

  onConnect(send: EventSink): void {
    this.sinks.add(send)
    send(this.snapshot())
    // Broker state is not history — reconnect recovery depends on this re-emit.
    for (const request of this.broker.pending()) send(this.toPermissionEvent(request))
    for (const request of this.questions.pending()) send(this.toQuestionEvent(request))
  }

  onMessage(raw: string): void {
    const message = parseClientMessage(raw)
    if (message === null) return

    switch (message.type) {
      case 'user_message':
        // One turn at a time per session — a mid-turn user_message is dropped.
        if (this.state !== 'streaming') void this.runTurn(message.text)
        return
      case 'permission_response':
        this.broker.resolve(message.requestId, message.decision)
        return
      case 'question_response':
        this.questions.resolve(message.requestId, message.answers)
        return
      case 'abort':
        this.turnAbort?.abort()
        this.broker.abort()
        this.questions.abort()
        return
    }
  }

  onClose(send: EventSink): void {
    // A bare disconnect never aborts — the turn keeps running; the next connect resyncs.
    this.sinks.delete(send)
  }

  /**
   * Deletion teardown (spec 2026-07-17): abort the in-flight turn — the same
   * path the 'abort' client message takes — then drop every sink so no further
   * event leaves this stream. Sockets are NOT closed here: the stream is
   * socket-free by design, and the single client (one Electron window) closes
   * its own socket; an orphaned socket is cleaned up by its onClose.
   */
  dispose(): void {
    this.turnAbort?.abort()
    this.broker.abort()
    this.questions.abort()
    this.sinks.clear()
  }

  private async runTurn(prompt: string): Promise<void> {
    const { projects, drafts, modelOverrides, permissionModes, preferences } = this.data.get()
    const project = projects.find((p) => p.id === this.projectId)
    if (!project) {
      this.setState('error')
      this.lastError = { reason: `unknown project: ${this.projectId}` }
      this.broadcast(this.snapshot())
      return
    }

    const resolvedId = this.data.resolveSessionId(this.id)
    const draft = drafts.find((d) => d.id === resolvedId)
    // A draft carries its own model until materialization moves it into modelOverrides.
    const model = draft?.model ?? modelOverrides[resolvedId] ?? preferences.defaultModel
    // Same draft-then-override resolution for the per-session permissions answer.
    // Unanswered (null/absent) runs as 'default' — never silently dangerous.
    const permissionMode = draft?.permissionMode ?? permissionModes[resolvedId] ?? 'default'

    this.setState('streaming')
    this.partialText = ''
    // Un tool_use avorté sans tool_result ne doit pas s'accumuler d'un tour à l'autre.
    this.suppressedToolUseIds.clear()
    this.lastError = undefined
    const abort = new AbortController()
    this.turnAbort = abort

    try {
      const turn = this.sdk.runTurn({
        cwd: project.path,
        model,
        prompt,
        resumeSessionId: draft ? undefined : resolvedId,
        // Routage canUseTool (spec QCM) : le QCM va au QuestionBroker — jamais aux
        // règles « always » ; le mode skip-permissions est un auto-allow sélectif
        // (plus de bypassPermissions SDK : il court-circuitait canUseTool et avalait le QCM).
        canUseTool: (toolName, input) => {
          if (toolName === 'AskUserQuestion') return this.questions.request(input)
          if (permissionMode === 'bypassPermissions') return Promise.resolve({ behavior: 'allow' as const })
          return this.broker.request(toolName, input)
        },
        signal: abort.signal,
      })
      // Owner-only event handling (drain-gap race, event flavor): the real
      // AgentSdkClient keeps draining the SDK stream AFTER yielding turn_done,
      // and its generator catch converts any late rejection into a YIELDED
      // turn_error — so post-drain failures arrive as events, not rejections.
      // Once this turn has settled (turn_done/turn_error seen) or a newer turn
      // owns this.turnAbort, its generator is stale: drop every further event,
      // or a late turn_error would flip an idle session to 'error' — and knock
      // a mid-flight turn 2 off 'streaming', letting a further user_message
      // violate the one-turn-per-session invariant.
      let settled = false
      for await (const event of turn) {
        if (settled || this.turnAbort !== abort) continue
        if (event.type === 'turn_done' || event.type === 'turn_error') settled = true
        await this.handleTurnEvent(event, draft?.id, abort.signal)
      }
    } catch (err) {
      // runTurn is fired-and-forgotten from onMessage — an escaping rejection
      // would be unhandled. Surface SDK failures as a status error instead —
      // unless the turn's own abort fired: an AbortError rejection is then a
      // normal Stop, and the finally block settles the state to idle. The
      // this.turnAbort identity check makes teardown owner-only: the real
      // AgentSdkClient keeps draining the SDK stream AFTER yielding turn_done
      // (state already 'idle'), so a user_message in that gap starts the next
      // turn — a late rejection from the drained turn must not clobber it.
      if (!abort.signal.aborted && this.turnAbort === abort) {
        this.setState('error')
        this.lastError = { reason: err instanceof Error ? err.message : String(err) }
        this.broadcast(this.snapshot())
      }
    } finally {
      // Owner-only teardown (same drain-gap race as above): once a newer turn
      // holds this.turnAbort, nulling it would kill its Stop, and the
      // 'streaming' settle would broadcast a spurious idle mid-turn — letting
      // a further user_message violate the one-turn-per-session invariant.
      if (this.turnAbort === abort) {
        this.turnAbort = null
        if (this.state === 'streaming') {
          // Aborted, or the turn ended without turn_done/turn_error — settle to idle.
          this.setState('idle')
          this.broadcast(this.snapshot())
        }
      }
    }
  }

  private async handleTurnEvent(event: SdkTurnEvent, draftId: string | undefined, signal: AbortSignal): Promise<void> {
    switch (event.type) {
      case 'text_delta':
        this.partialText += event.text
        this.broadcast({ type: 'assistant_delta', sessionId: this.sessionId(), text: event.text })
        return
      case 'tool_use':
        // A tool_use closes the current text run — the buffer tracks only the in-flight run.
        // Ce reset reste MÊME quand le broadcast est supprimé (QCM) : sinon le snapshot
        // de reconnexion re-servirait le texte pré-QCM comme run en cours.
        this.partialText = ''
        if (event.toolName === 'AskUserQuestion') {
          // La carte QCM est la représentation du tour — une ligne outil doublonnerait.
          this.suppressedToolUseIds.add(event.toolUseId)
          return
        }
        this.broadcast({
          type: 'tool_use',
          sessionId: this.sessionId(),
          toolUseId: event.toolUseId,
          ...describeToolUse(event.toolName, event.input),
        })
        return
      case 'tool_result':
        if (this.suppressedToolUseIds.delete(event.toolUseId)) return
        this.broadcast({
          type: 'tool_result',
          sessionId: this.sessionId(),
          toolUseId: event.toolUseId,
          ok: event.ok,
          summary: event.summary,
        })
        return
      case 'usage':
        this.data.recordUsage({
          at: new Date().toISOString(),
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheCreationTokens: event.cacheCreationTokens,
        })
        this.broadcast({
          type: 'usage',
          sessionId: this.sessionId(),
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheCreationTokens: event.cacheCreationTokens,
        })
        return
      case 'rate_limit': {
        // Plan gauges: persist the latest per window (REST snapshot for app
        // open) and broadcast live so open panels move during the turn.
        const limit = {
          window: event.window,
          utilization: event.utilization,
          status: event.status,
          ...(event.resetsAt !== undefined ? { resetsAt: event.resetsAt } : {}),
          recordedAt: new Date().toISOString(),
        }
        this.data.recordRateLimit(limit)
        this.broadcast({ type: 'rate_limit', sessionId: this.sessionId(), limit })
        return
      }
      case 'commands':
        // Le SDK a repoussé la liste complète (skill découvert en cours de
        // session…) : on la relaie telle quelle, le client REMPLACE la sienne.
        this.broadcast({ type: 'commands', sessionId: this.sessionId(), commands: event.commands })
        return
      case 'session_started':
        if (draftId !== undefined) this.materializeDraft(draftId, event.sessionId)
        return
      case 'turn_done':
        // The SDK CLI has flushed the session JSONL by turn end — apply the
        // deferred rename now, before the idle settle, so a sessions-list
        // refetch triggered by the idle status already sees the new name.
        await this.applyPendingRename()
        this.setState('idle')
        this.broadcast(this.snapshot())
        return
      case 'turn_error':
        // A user abort surfaces from the real AgentSdkClient as a turn_error
        // (the SDK query rejects with an AbortError, converted downstream) —
        // that is a normal Stop, not an error; finally settles the state to idle.
        if (signal.aborted) return
        this.setState('error')
        this.lastError = event.resetAt !== undefined ? { reason: event.reason, resetAt: event.resetAt } : { reason: event.reason }
        this.broadcast(this.snapshot())
        return
    }
  }

  private materializeDraft(draftId: string, sdkSessionId: string): void {
    // mapDraft moves the draft's model into modelOverrides[sdkSessionId] — loss-less.
    const { deferredName } = this.data.mapDraft(draftId, sdkSessionId)
    // Re-key the registry in the SAME synchronous step as mapDraft: from here on
    // both ids resolve to sdkSessionId, so a stale draft-id key would make every
    // future lookup miss and mint a duplicate stream.
    this.onRekey?.(draftId, sdkSessionId)
    // Re-emits under the SDK id. NB: the `streaming` emission under the DRAFT id (line ~120)
    // is not retracted → a stale `draftId → streaming` entry may linger in the client's `statuses`.
    // Harmless: the `mapping` remap removes the draft from the session list, so it never renders
    // nor transitions to `waiting`; any new hub connection snapshots the re-keyed `streams` map cleanly.
    this.onStatusChange?.(sdkSessionId, this.state)
    // The rename itself must WAIT for turn end: at session_started the SDK CLI
    // has not yet flushed the session JSONL to ~/.claude/projects, so renaming
    // here throws "Session not found in any project directory" (observed live).
    if (deferredName !== null) this.pendingRename = { sessionId: sdkSessionId, name: deferredName }
    this.broadcast({
      type: 'status',
      sessionId: sdkSessionId,
      state: 'streaming',
      mapping: { draftId, sessionId: sdkSessionId },
    })
  }

  /**
   * Applies the deferred draft rename, at most once. NEVER fatal: a rename
   * failure is cosmetic (the draft name is lost; spec surfaces it as a toast) —
   * letting it throw would kill the turn's event loop mid-stream instead.
   */
  private async applyPendingRename(): Promise<void> {
    const pending = this.pendingRename
    if (pending === null) return
    this.pendingRename = null
    try {
      await this.sdk.renameSession(pending.sessionId, pending.name)
    } catch (err) {
      console.error(`[session-stream] deferred rename of ${pending.sessionId} failed:`, err)
    }
  }

  /** Events are stamped with the resolved id — after materialization the SDK id. */
  private sessionId(): string {
    return this.data.resolveSessionId(this.id)
  }

  /** État live courant — lu par le registre pour le snapshot du hub. */
  get currentState(): SessionState {
    return this.state
  }

  /** Unique point de mutation de `state` : notifie le hub à chaque transition. */
  private setState(next: SessionState): void {
    this.state = next
    // Les échecs d'un abonné (hub/socket) ne doivent JAMAIS affecter l'état du tour :
    // une exception ici, propagée dans le catch de runTurn, basculerait un tour réussi en 'error'.
    try {
      this.onStatusChange?.(this.sessionId(), next)
    } catch (err) {
      console.error('[session-stream] onStatusChange a levé une exception (ignorée):', err)
    }
  }

  private snapshot(): ServerEvent {
    const base = { type: 'status' as const, sessionId: this.sessionId(), state: this.state }
    if (this.state === 'streaming') return { ...base, partialText: this.partialText }
    if (this.state === 'error' && this.lastError) return { ...base, error: this.lastError }
    return base
  }

  private toPermissionEvent(request: PermissionRequest): ServerEvent {
    return { ...request, sessionId: this.sessionId() }
  }

  private toQuestionEvent(request: QuestionRequest): ServerEvent {
    return { ...request, sessionId: this.sessionId() }
  }

  private broadcast(event: ServerEvent): void {
    for (const send of this.sinks) send(event)
  }
}

/**
 * Per-session singletons keyed by the RESOLVED session id, so reconnects — with
 * the draft id or the SDK id — attach to the same live stream.
 */
export class SessionStreamRegistry {
  private readonly streams = new Map<string, SessionStream>()
  private readonly statusSinks = new Set<(event: StatusHubEvent) => void>()

  constructor(
    private readonly data: AppData,
    private readonly sdk: SdkClient
  ) {}

  get(id: string, projectId: string): SessionStream {
    const key = this.data.resolveSessionId(id)
    let stream = this.streams.get(key)
    if (!stream) {
      stream = new SessionStream({
        id: key,
        projectId,
        data: this.data,
        sdk: this.sdk,
        onRekey: (from, to) => {
          const entry = this.streams.get(from)
          if (entry) {
            this.streams.delete(from)
            this.streams.set(to, entry)
          }
        },
        onStatusChange: (sessionId, state) => this.publishStatus(sessionId, state),
      })
      this.streams.set(key, stream)
    }
    return stream
  }

  /** Abonne un sink au flux d'état global : snapshot immédiat de toutes les sessions vivantes, puis transitions (et événements autopilot — spec 2026-08-05). */
  onStatusConnect(send: (event: StatusHubEvent) => void): void {
    // Snapshot construit AVANT l'abonnement : un sink qui lève ne doit pas rester
    // abonné avec un snapshot partiel, ni faire échouer la glue WS de l'appelant.
    const snapshot: SessionStatusEvent[] = []
    for (const [sessionId, stream] of this.streams) {
      snapshot.push({ type: 'session_status', sessionId, state: stream.currentState })
    }
    this.statusSinks.add(send)
    for (const event of snapshot) {
      try {
        send(event)
      } catch (err) {
        console.error('[session-stream] status sink a levé au snapshot (ignoré):', err)
      }
    }
  }

  onStatusClose(send: (event: StatusHubEvent) => void): void {
    this.statusSinks.delete(send)
  }

  /** Diffuse un événement du hub (transitions de session, état autopilot) à tous les sinks — garde par-sink. */
  publish(event: StatusHubEvent): void {
    // Garde par-sink : un sink qui lève (ex. ws.send sur un socket en teardown) ne
    // doit pas interrompre le for...of et priver les sinks suivants de la transition.
    for (const send of this.statusSinks) {
      try {
        send(event)
      } catch (err) {
        console.error('[session-stream] status sink a levé (ignoré):', err)
      }
    }
  }

  private publishStatus(sessionId: string, state: SessionState): void {
    this.publish({ type: 'session_status', sessionId, state })
  }

  /**
   * Removes a session's singleton before its on-disk deletion — without this the
   * cached stream outlives the deleted JSONL and a reconnect would resurrect a
   * ghost session. Idempotent; resolves draft ids like get() does.
   */
  dispose(id: string): void {
    const key = this.data.resolveSessionId(id)
    const stream = this.streams.get(key)
    if (!stream) return
    stream.dispose()
    this.streams.delete(key)
  }
}
