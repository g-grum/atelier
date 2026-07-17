import type { ChatMessage, PermissionDecision, ProposedRule, ServerEvent, ToolKind } from '@atelier/shared'

export type ChatItem =
  | { kind: 'user'; text: string; /** true while the message waits in the client-side queue (sent at next idle). */ queued?: boolean }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | {
      kind: 'tool'
      toolUseId: string
      tool: ToolKind
      summary: string
      file?: string
      line?: number
      diffstat?: { added: number; removed: number }
      result?: { ok: boolean; summary: string }
    }
  | {
      kind: 'permission'
      requestId: string
      toolName: string
      rendered: string
      proposedRule: ProposedRule | null
      resolved?: PermissionDecision
    }

export type StreamState = {
  items: ChatItem[]
  status: 'idle' | 'streaming' | 'error'
  error?: { reason: string; resetAt?: string }
  sessionTokens: { input: number; output: number; cacheRead: number; cacheCreation: number }
  modifiedFiles: Map<string, { added: number; removed: number; lastLine?: number }>
}

export function initialState(): StreamState {
  return {
    items: [],
    status: 'idle',
    sessionTokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modifiedFiles: new Map(),
  }
}

/** Rebuild the view-model from persisted history (session open and reconnect resync). */
export function reset(history: ChatMessage[]): StreamState {
  const state = initialState()
  for (const message of history) {
    switch (message.role) {
      case 'user':
        state.items.push({ kind: 'user', text: message.text })
        break
      case 'assistant':
        state.items.push({ kind: 'assistant', text: message.text, streaming: false })
        break
      case 'tool':
        state.items.push({
          kind: 'tool',
          toolUseId: message.toolUseId,
          tool: message.kind,
          summary: message.summary,
          file: message.file,
          line: message.line,
          diffstat: message.diffstat,
          // History persists only the outcome flag — the result detail is not stored.
          result: { ok: message.ok, summary: '' },
        })
        trackModifiedFile(state.modifiedFiles, message.kind, message.file, message.diffstat, message.line)
        break
    }
  }
  return state
}

export function reduce(state: StreamState, event: ServerEvent): StreamState {
  switch (event.type) {
    case 'assistant_delta':
      return applyDelta(state, event.text)
    case 'tool_use':
      return applyToolUse(state, event)
    case 'tool_result':
      return applyToolResult(state, event)
    case 'permission_request':
      return applyPermissionRequest(state, event)
    case 'usage':
      return {
        ...state,
        sessionTokens: {
          input: state.sessionTokens.input + event.inputTokens,
          output: state.sessionTokens.output + event.outputTokens,
          cacheRead: state.sessionTokens.cacheRead + event.cacheReadTokens,
          cacheCreation: state.sessionTokens.cacheCreation + event.cacheCreationTokens,
        },
      }
    case 'status':
      return applyStatus(state, event)
  }
}

/** Local (optimistic) resolution — the definitive removal happens server-side. */
export function resolvePermission(state: StreamState, requestId: string, decision: PermissionDecision): StreamState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === 'permission' && item.requestId === requestId ? { ...item, resolved: decision } : item,
    ),
  }
}

function applyDelta(state: StreamState, text: string): StreamState {
  const items = [...state.items]
  const last = items.at(-1)
  if (last !== undefined && last.kind === 'assistant' && last.streaming) {
    items[items.length - 1] = { ...last, text: last.text + text }
  } else {
    items.push({ kind: 'assistant', text, streaming: true })
  }
  // Deltas only ever arrive mid-turn — the server does not broadcast a
  // 'streaming' status at turn start, so the reducer infers it.
  return { ...state, status: 'streaming', items }
}

function applyToolUse(state: StreamState, event: Extract<ServerEvent, { type: 'tool_use' }>): StreamState {
  const items = closeTextRun(state.items)
  items.push({
    kind: 'tool',
    toolUseId: event.toolUseId,
    tool: event.kind,
    summary: event.summary,
    file: event.file,
    line: event.line,
    diffstat: event.diffstat,
  })
  const modifiedFiles = new Map(state.modifiedFiles)
  trackModifiedFile(modifiedFiles, event.kind, event.file, event.diffstat, event.line)
  return { ...state, status: 'streaming', items, modifiedFiles }
}

function applyToolResult(state: StreamState, event: Extract<ServerEvent, { type: 'tool_result' }>): StreamState {
  const items = state.items.map((item) =>
    item.kind === 'tool' && item.toolUseId === event.toolUseId
      ? { ...item, result: { ok: event.ok, summary: event.summary } }
      : item,
  )
  return { ...state, items }
}

function applyPermissionRequest(state: StreamState, event: Extract<ServerEvent, { type: 'permission_request' }>): StreamState {
  // The server re-emits pending requests on every reconnect — dedupe by requestId.
  if (state.items.some((item) => item.kind === 'permission' && item.requestId === event.requestId)) return state
  // A permission blocks the turn until decided, then a tool_use closes the run
  // server-side — the current text run is over either way.
  const items = closeTextRun(state.items)
  items.push({
    kind: 'permission',
    requestId: event.requestId,
    toolName: event.toolName,
    rendered: event.rendered,
    proposedRule: event.proposedRule,
  })
  return { ...state, status: 'streaming', items }
}

function applyStatus(state: StreamState, event: Extract<ServerEvent, { type: 'status' }>): StreamState {
  // event.mapping is deliberately ignored here: draft remap is handled by the
  // controller (onSessionRemapped), not by the view-model state.
  const next: StreamState = { ...state, status: event.state, error: event.state === 'error' ? event.error : undefined }
  if (event.state === 'idle' || event.state === 'error') {
    // The turn is over — no more deltas will arrive.
    next.items = state.items.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item))
  } else if (event.partialText !== undefined && event.partialText !== '') {
    // Snapshot of the in-flight text run (sent on every connect mid-turn):
    // authoritative — it replaces the current run or seeds it right after reset.
    const items = [...state.items]
    const last = items.at(-1)
    if (last !== undefined && last.kind === 'assistant' && last.streaming) {
      items[items.length - 1] = { ...last, text: event.partialText }
    } else {
      items.push({ kind: 'assistant', text: event.partialText, streaming: true })
    }
    next.items = items
  }
  return next
}

/** A tool_use / permission_request ends the current assistant text run. */
function closeTextRun(items: ChatItem[]): ChatItem[] {
  return items.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item))
}

function trackModifiedFile(
  modifiedFiles: Map<string, { added: number; removed: number; lastLine?: number }>,
  kind: ToolKind,
  file: string | undefined,
  diffstat: { added: number; removed: number } | undefined,
  line: number | undefined,
): void {
  if (file === undefined || (kind !== 'Edit' && kind !== 'Write')) return
  const previous = modifiedFiles.get(file) ?? { added: 0, removed: 0 }
  modifiedFiles.set(file, {
    added: previous.added + (diffstat?.added ?? 0),
    removed: previous.removed + (diffstat?.removed ?? 0),
    lastLine: line ?? previous.lastLine,
  })
}
