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
} from '@anthropic-ai/claude-agent-sdk'
import type { ChatMessage } from '@atelier/shared'

// ── Public types ────────────────────────────────────────────────────────────

export type SdkSessionInfo = { id: string; name: string | null; updatedAt: string; messageCount: number }

export type SdkTurnEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; summary: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
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
    const messages = await getSessionMessages(sessionId)
    const result: ChatMessage[] = []
    for (const m of messages) {
      if (m.type === 'user') {
        const msg = m.message as { content?: unknown }
        const text = typeof msg?.content === 'string' ? msg.content : '[user]'
        result.push({ role: 'user', text, at: new Date().toISOString() })
      } else if (m.type === 'assistant') {
        const msg = m.message as { content?: unknown }
        if (Array.isArray(msg?.content)) {
          for (const block of msg.content) {
            if (block && typeof block === 'object') {
              if ((block as { type?: string }).type === 'text') {
                // BetaTextBlock.text
                result.push({ role: 'assistant', text: (block as { text: string }).text, at: new Date().toISOString() })
              } else if ((block as { type?: string }).type === 'tool_use') {
                // seam for task 3.2: toChatToolMessage wires proper summary/file/line later
                result.push(toChatToolMessage(block as { id: string; name: string; input: unknown }))
              }
            }
          }
        }
      }
    }
    return result
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

    const q = query({
      prompt: params.prompt,
      options: {
        cwd: params.cwd,
        model: params.model,
        resume: params.resumeSessionId,
        abortController,
        // SDK CanUseTool: (toolName, input, options) → PermissionResult
        canUseTool: async (toolName, input) => {
          const result = await params.canUseTool(toolName, input)
          if (result.behavior === 'allow') return { behavior: 'allow' }
          return { behavior: 'deny', message: result.message }
        },
      },
    })

    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (params.signal.aborted) break

        // SDKSystemMessage: type='system', subtype='init' carries session_id
        if (msg.type === 'system' && msg.subtype === 'init') {
          yield { type: 'session_started', sessionId: msg.session_id }
          continue
        }

        // SDKPartialAssistantMessage: type='stream_event', event is BetaRawMessageStreamEvent
        if (msg.type === 'stream_event') {
          const ev = msg.event
          // BetaRawContentBlockDeltaEvent: event.type='content_block_delta', event.delta.type='text_delta'
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: (ev.delta as { type: 'text_delta'; text: string }).text }
          }
          continue
        }

        // SDKAssistantMessage: type='assistant', message is BetaMessage (content blocks)
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

/**
 * Seam for task 3.2: will be replaced with proper describe-module mapping.
 * Returns a minimal tool ChatMessage with rough values for now.
 */
function toChatToolMessage(block: { id: string; name: string; input: unknown }): ChatMessage {
  return { role: 'tool', toolUseId: block.id, kind: 'Other', summary: block.name, ok: true, at: new Date().toISOString() }
}

/**
 * SDK's SDKSessionInfo has no messageCount. Fall back to counting JSONL lines.
 * Reads ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl; never throws.
 */
function deriveMessageCount(sessionId: string, cwd: string): number {
  try {
    const projectKey = cwd.replaceAll('/', '-').replace(/^-/, '')
    const path = join(homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`)
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    return lines.length
  } catch {
    return 0
  }
}
