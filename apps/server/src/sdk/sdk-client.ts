import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  type SDKMessage,
  type SDKRateLimitEvent,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ChatMessage, RateLimitWindow } from '@atelier/shared'
import { describeToolUse } from '../stream/describe-tool-use'

// ── Public types ────────────────────────────────────────────────────────────

export type SdkSessionInfo = { id: string; name: string | null; updatedAt: string; messageCount: number }

export type SdkTurnEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; summary: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  /** Live turn-cumulative counters from message_start/message_delta — transient; 'usage' (the result) is authoritative. */
  | { type: 'usage_progress'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  | { type: 'rate_limit'; window: RateLimitWindow; utilization: number; status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: string }
  | { type: 'session_started'; sessionId: string }
  | { type: 'turn_done' }
  | { type: 'turn_error'; reason: string; resetAt?: string }

export type CanUseTool = (toolName: string, input: unknown) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }>

export type RunTurnParams = {
  cwd: string
  model: string
  prompt: string
  resumeSessionId?: string
  canUseTool: CanUseTool
  signal: AbortSignal
  /** Session-level « dangerously skip permissions » answer — maps to the SDK's bypassPermissions mode. */
  bypassPermissions?: boolean
}

export interface SdkClient {
  listSessions(cwd: string): Promise<SdkSessionInfo[]>
  getSessionMessages(sessionId: string): Promise<ChatMessage[]>
  renameSession(sessionId: string, name: string): Promise<void>
  runTurn(params: RunTurnParams): AsyncIterable<SdkTurnEvent>
}

// ── AgentSdkClient ──────────────────────────────────────────────────────────

export class AgentSdkClient implements SdkClient {
  /** SDK: listSessions({ dir }) → SDKSessionInfo[] (fields: sessionId, customTitle, summary, lastModified, cwd) */
  async listSessions(cwd: string): Promise<SdkSessionInfo[]> {
    const sessions = await listSessions({ dir: cwd })
    return sessions.map((s) => ({
      id: s.sessionId,
      // customTitle is the user-set /rename title; summary is auto-generated
      name: s.customTitle ?? s.summary ?? null,
      updatedAt: new Date(s.lastModified).toISOString(),
      messageCount: deriveMessageCount(s.sessionId, cwd),
    }))
  }

  /** SDK: getSessionMessages(sessionId) → SessionMessage[] (fields: type, message) */
  async getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
    return mapSessionMessages(await getSessionMessages(sessionId))
  }

  /** SDK: renameSession(sessionId, title) → Promise<void> */
  async renameSession(sessionId: string, name: string): Promise<void> {
    await renameSession(sessionId, name)
  }

  /** SDK: query({ prompt, options }) → Query (AsyncGenerator<SDKMessage>) */
  async *runTurn(params: RunTurnParams): AsyncIterable<SdkTurnEvent> {
    const abortController = new AbortController()
    params.signal.addEventListener('abort', () => abortController.abort())

    let pendingResetAt: string | undefined
    const usageTracker = new UsageProgressTracker()

    const q = query({
      prompt: params.prompt,
      options: buildQueryOptions(params, abortController),
    })

    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (params.signal.aborted) break

        // SDKSystemMessage: type='system', subtype='init' carries session_id
        if (msg.type === 'system' && msg.subtype === 'init') {
          yield { type: 'session_started', sessionId: msg.session_id }
          // Full plan picture once per turn: the get_usage control request
          // returns EVERY window (the live rate_limit_events only carry the
          // representative one). Experimental SDK API — silent on failure,
          // and rate_limits_available is false on API-key/3P sessions.
          try {
            const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
            if (usage.rate_limits_available && usage.rate_limits != null) {
              for (const event of mapUsageWindows(usage.rate_limits as Record<string, { utilization: number | null; resets_at: string | null } | null>)) {
                yield event
              }
            }
          } catch {
            // Never let a usage probe break the turn.
          }
          continue
        }

        // SDKPartialAssistantMessage: type='stream_event', event is BetaRawMessageStreamEvent.
        // Only emitted when options.includePartialMessages is true (sdk.d.ts) —
        // see buildQueryOptions. parent_tool_use_id is non-null for subagent
        // streams (sdk.d.ts: 'string | null'): only top-level text belongs in the chat.
        if (msg.type === 'stream_event') {
          const ev = msg.event
          // BetaRawContentBlockDeltaEvent: event.type='content_block_delta', event.delta.type='text_delta'
          if (msg.parent_tool_use_id === null && ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: (ev.delta as { type: 'text_delta'; text: string }).text }
          }
          // Live usage: message_start/message_delta carry real per-step token
          // counters. Subagent streams included — their spend is real spend,
          // and the final result usage settles any difference.
          const progress = usageTracker.track(ev as UsageBearingStreamEvent)
          if (progress !== null) yield progress
          continue
        }

        // SDKAssistantMessage: type='assistant', message is BetaMessage (content blocks).
        // Text blocks are deliberately NOT extracted here: with
        // includePartialMessages on, the full reply already arrived as
        // stream_event text_deltas — re-emitting the final text blocks would
        // double every reply. Deltas are the single text source.
        if (msg.type === 'assistant') {
          const content = (msg.message as { content?: unknown }).content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (!block || typeof block !== 'object') continue
              const b = block as { type?: string }
              // BetaToolUseBlock: type='tool_use', id, name, input
              if (b.type === 'tool_use') {
                const tb = block as { id: string; name: string; input: unknown }
                yield { type: 'tool_use', toolUseId: tb.id, toolName: tb.name, input: tb.input }
              }
            }
          }
          continue
        }

        // SDKUserMessage: type='user' — tool_result blocks (model's perspective)
        if (msg.type === 'user') {
          const content = (msg.message as { content?: unknown }).content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (!block || typeof block !== 'object') continue
              const b = block as { type?: string }
              // tool_result block: type='tool_result', tool_use_id, is_error, content
              if (b.type === 'tool_result') {
                const tb = block as { tool_use_id: string; is_error?: boolean; content?: unknown }
                const ok = !tb.is_error
                const summary = typeof tb.content === 'string' ? tb.content : ok ? 'ok' : 'error'
                yield { type: 'tool_result', toolUseId: tb.tool_use_id, ok, summary }
              }
            }
          }
          continue
        }

        // SDKRateLimitEvent: type='rate_limit_event', rate_limit_info.resetsAt (epoch ms)
        if (msg.type === 'rate_limit_event') {
          const rle = msg as SDKRateLimitEvent
          if (rle.rate_limit_info.resetsAt != null) {
            pendingResetAt = new Date(rle.rate_limit_info.resetsAt).toISOString()
          }
          // Plan gauges (the claude.ai/usage numbers) — yielded when complete.
          const limit = mapRateLimitInfo(rle.rate_limit_info)
          if (limit !== null) yield limit
          continue
        }

        // SDKResultMessage: type='result'
        if (msg.type === 'result') {
          // SDKResultSuccess/SDKResultError: usage has input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens (NonNullableUsage = BetaUsage with non-null)
          const usage = msg.usage as {
            input_tokens: number
            output_tokens: number
            cache_read_input_tokens: number
            cache_creation_input_tokens: number
          }
          yield {
            type: 'usage',
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens,
            cacheCreationTokens: usage.cache_creation_input_tokens,
          }

          if (msg.subtype === 'success') {
            yield { type: 'turn_done' }
          } else {
            // SDKResultError.errors is string[] with error description(s)
            const reason = (msg as { errors?: string[] }).errors?.[0] ?? msg.subtype
            yield { type: 'turn_error', reason, resetAt: pendingResetAt }
          }
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      yield { type: 'turn_error', reason }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type QueryOptions = NonNullable<Parameters<typeof query>[0]['options']>

/**
 * Builds the SDK query() options for one turn. Exported as the unit-testable
 * seam for two real-SDK boundary contracts the mock can't see:
 *
 * - includePartialMessages (sdk.d.ts Options): "When true,
 *   SDKPartialAssistantMessage events will be emitted during streaming."
 *   Without it the SDK emits NO stream_event at all — zero text deltas ever
 *   reach the client (observed live).
 *
 * - canUseTool allow shape: PermissionResult (sdk.d.ts) declares
 *   `updatedInput?: Record<string, unknown>` as OPTIONAL, but the BUNDLED CLI
 *   binary the SDK actually spawns (claude-agent-sdk-darwin-arm64/claude, 2.1.198)
 *   Zod-REQUIRES it on the permission control response:
 *   `behavior:literal("allow"),updatedInput:record(string(),unknown())` — a
 *   bare `{ behavior: 'allow' }` fails the whole permission request with
 *   "Tool permission request failed: ZodError" (observed live). Echo the
 *   original input back unchanged.
 */
export function buildQueryOptions(params: RunTurnParams, abortController: AbortController): QueryOptions {
  return {
    cwd: params.cwd,
    model: params.model,
    resume: params.resumeSessionId,
    abortController,
    includePartialMessages: true,
    // sdk.d.ts: permissionMode 'bypassPermissions' REQUIRES allowDangerouslySkipPermissions: true
    // (intentionality safety flag) — and short-circuits canUseTool entirely.
    ...(params.bypassPermissions === true ? { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true } : {}),
    // SDK CanUseTool: (toolName, input: Record<string, unknown>, options) → PermissionResult
    canUseTool: async (toolName, input) => {
      const result = await params.canUseTool(toolName, input)
      if (result.behavior === 'allow') return { behavior: 'allow', updatedInput: input }
      return { behavior: 'deny', message: result.message }
    },
  }
}

/**
 * Maps recorded SessionMessages to the chat history contract. Exported as the
 * unit-testable seam for the transcript-format boundary (same rationale as
 * buildQueryOptions): the class method is a thin SDK call around this.
 */
export function mapSessionMessages(messages: SessionMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  for (const m of messages) {
    if (m.type === 'user') {
      // Transcript-format boundary (observed live in ~/.claude/projects): the
      // CLI ≥2.x persists user prompts as content-block arrays
      // [{type:'text',text}], older transcripts as plain strings. type='user'
      // lines whose content is ONLY tool_result blocks are the model-side echo
      // of tool results — no text extracted → no chat item (mirrors runTurn,
      // where user text is never emitted and tool_results attach to the tool).
      const text = userText((m.message as { content?: unknown })?.content)
      if (text !== null) result.push({ role: 'user', text, at: new Date().toISOString() })
    } else if (m.type === 'assistant') {
      const msg = m.message as { content?: unknown }
      if (Array.isArray(msg?.content)) {
        for (const block of msg.content) {
          if (block && typeof block === 'object') {
            if ((block as { type?: string }).type === 'text') {
              // BetaTextBlock.text
              result.push({ role: 'assistant', text: (block as { text: string }).text, at: new Date().toISOString() })
            } else if ((block as { type?: string }).type === 'tool_use') {
              result.push(toChatToolMessage(block as { id: string; name: string; input: unknown }))
            }
          }
        }
      }
    }
  }
  return result
}

/** Extracts the user-visible text of a recorded user message, or null when it carries none (e.g. tool_result-only lines). */
function userText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const texts = content
    .filter((block): block is { type: 'text'; text: string } => block != null && typeof block === 'object' && (block as { type?: string }).type === 'text')
    .map((block) => block.text)
  return texts.length > 0 ? texts.join('\n\n') : null
}

/** Maps a recorded tool_use block through describe-tool-use so resumed sessions render like live ones. */
function toChatToolMessage(block: { id: string; name: string; input: unknown }): ChatMessage {
  return { role: 'tool', toolUseId: block.id, ...describeToolUse(block.name, block.input), ok: true, at: new Date().toISOString() }
}

/** One window of the get_usage control response — utilization is ALREADY a 0-100 percent (unlike SDKRateLimitInfo's fraction). */
type UsageWindowInfo = { utilization: number | null; resets_at: string | null } | null | undefined

const USAGE_WINDOWS: readonly RateLimitWindow[] = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage']

/**
 * Maps the get_usage control response's rate_limits record to one rate_limit
 * turn event per present window — the full claude.ai/usage picture, fetched
 * once per turn (the live rate_limit_events only ever carry the single
 * "representative" window, which is why a quiet window would otherwise go
 * stale on screen). The endpoint has no per-window status: derive it from the
 * percent (≥80 warns, ≥100 rejects — clamped). Unknown keys are skipped.
 */
export function mapUsageWindows(rateLimits: Record<string, UsageWindowInfo>): Extract<SdkTurnEvent, { type: 'rate_limit' }>[] {
  const events: Extract<SdkTurnEvent, { type: 'rate_limit' }>[] = []
  for (const window of USAGE_WINDOWS) {
    const info = rateLimits[window]
    if (info == null || info.utilization == null) continue
    const utilization = Math.min(100, Math.max(0, Math.floor(info.utilization)))
    events.push({
      type: 'rate_limit',
      window,
      utilization,
      status: utilization >= 100 ? 'rejected' : utilization >= 80 ? 'allowed_warning' : 'allowed',
      ...(info.resets_at !== null ? { resetsAt: info.resets_at } : {}),
    })
  }
  return events
}

/** The two stream-event shapes the tracker reads — structural subset of BetaRawMessageStreamEvent. */
type UsageBearingStreamEvent = {
  type: string
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
  usage?: { output_tokens?: number }
}

/**
 * Live usage across ONE turn, fed by the raw stream events that
 * includePartialMessages exposes. Real API numbers, never an estimate:
 * - message_start carries the step's input + cache counters (and an initial
 *   output count) — a multi-step agentic turn emits one per API round-trip,
 *   so totals climb DURING the turn, not only at its end.
 * - message_delta carries the CUMULATIVE output_tokens of the current message.
 * track() returns a turn-cumulative snapshot (or null for irrelevant events);
 * the final 'usage' event from the result message remains authoritative.
 */
export class UsageProgressTracker {
  private input = 0
  private cacheRead = 0
  private cacheCreation = 0
  /** Output of the messages already completed in this turn. */
  private foldedOutput = 0
  /** Cumulative output of the in-flight message (replaced by each message_delta). */
  private currentOutput = 0

  track(event: UsageBearingStreamEvent): Extract<SdkTurnEvent, { type: 'usage_progress' }> | null {
    if (event.type === 'message_start') {
      const usage = event.message?.usage ?? {}
      this.input += usage.input_tokens ?? 0
      this.cacheRead += usage.cache_read_input_tokens ?? 0
      this.cacheCreation += usage.cache_creation_input_tokens ?? 0
      // The previous message is over — fold its output before starting the new one.
      this.foldedOutput += this.currentOutput
      this.currentOutput = usage.output_tokens ?? 0
      return this.snapshot()
    }
    if (event.type === 'message_delta' && event.usage?.output_tokens !== undefined) {
      this.currentOutput = event.usage.output_tokens
      return this.snapshot()
    }
    return null
  }

  private snapshot(): Extract<SdkTurnEvent, { type: 'usage_progress' }> {
    return {
      type: 'usage_progress',
      inputTokens: this.input,
      outputTokens: this.foldedOutput + this.currentOutput,
      cacheReadTokens: this.cacheRead,
      cacheCreationTokens: this.cacheCreation,
    }
  }
}

/**
 * Maps one SDKRateLimitInfo to a rate_limit turn event. Unit-testable seam for
 * two boundary contracts the mock can't see:
 * - `utilization` is a 0–1 FRACTION: the bundled CLI renders it via
 *   `Math.floor(e.utilization*100)` — mirror that, clamped to 0–100.
 * - `resetsAt` is epoch ms in practice, but guard the seconds flavor: any
 *   value below 1e12 cannot be milliseconds in this century — promote it.
 * Returns null when rateLimitType or utilization is missing (honest-data
 * policy: nothing to display).
 */
export function mapRateLimitInfo(info: {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  rateLimitType?: RateLimitWindow
  utilization?: number
  resetsAt?: number
}): Extract<SdkTurnEvent, { type: 'rate_limit' }> | null {
  if (info.rateLimitType === undefined || info.utilization === undefined) return null
  const utilization = Math.min(100, Math.max(0, Math.floor(info.utilization * 100)))
  const event: Extract<SdkTurnEvent, { type: 'rate_limit' }> = {
    type: 'rate_limit',
    window: info.rateLimitType,
    utilization,
    status: info.status,
  }
  if (info.resetsAt != null) {
    event.resetsAt = new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt).toISOString()
  }
  return event
}

/**
 * Mirrors the CLI's ~/.claude/projects directory encoding, verified empirically
 * against the real entries AND the SDK bundle (`replace(/[^a-zA-Z0-9]/g,"-")`):
 * EVERY non-alphanumeric character becomes '-', and the leading dash is KEPT —
 * '/Users/x/ws/atelier' → '-Users-x-ws-atelier', '/ws/app/.claude' → '-ws-app--claude'.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * SDK's SDKSessionInfo has no messageCount. Fall back to counting JSONL lines.
 * Reads <projectsRoot>/<encoded-cwd>/<sessionId>.jsonl; never throws.
 */
export function deriveMessageCount(sessionId: string, cwd: string, projectsRoot?: string): number {
  try {
    // Resolved INSIDE the try — the never-throws contract covers homedir() too.
    const root = projectsRoot ?? join(homedir(), '.claude', 'projects')
    const path = join(root, encodeProjectDir(cwd), `${sessionId}.jsonl`)
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    return lines.length
  } catch {
    return 0
  }
}
