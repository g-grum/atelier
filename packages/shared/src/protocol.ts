export const PROTOCOL_VERSION = 1

export const ToolKinds = {
  Bash: 'Bash',
  Edit: 'Edit',
  Write: 'Write',
  Read: 'Read',
  Other: 'Other',
} as const
export type ToolKind = (typeof ToolKinds)[keyof typeof ToolKinds]

export type AlwaysRule = {
  id: string
  projectId: string
  toolName: string
  /** Bash: word-boundary command prefix. File tools: path glob. null: whole tool (non-sensitive only). */
  matcher: string | null
}

export type ProposedRule = Pick<AlwaysRule, 'toolName' | 'matcher'>

export const MODELS = ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6'] as const

export type Project = { id: string; path: string; color: string }
/** REST shape of GET/POST /api/projects. The persisted Project stays count-free — a derived count goes stale instantly, so the routes enrich through SessionsService.countSessions at response time; never persist it. */
export type ProjectSummary = Project & { sessionCount: number }
export type Preferences = {
  ide: 'webstorm' | 'vscode' | 'cursor' | 'idea'
  defaultModel: string
  /** Calibratable 5h-window token budget — an ESTIMATE (no public API exposes plan limits); the store guarantees a default. */
  windowBudgetTokens: number
  /** Calibratable weekly (trailing 7 days) token budget — same estimate policy as windowBudgetTokens. */
  weeklyBudgetTokens: number
}

/** One recorded usage sample (REST: GET /api/usage/history). All four counters persist — the forecast's fidelity depends on cache counts; a lossy total can't be backfilled. */
export type UsageEvent = { at: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }

/**
 * Per-session permission behavior for SDK turns. 'bypassPermissions' maps to
 * the Agent SDK's dangerously-skip-permissions mode (canUseTool is bypassed).
 */
export type SessionPermissionMode = 'default' | 'bypassPermissions'
export const SESSION_PERMISSION_MODES: readonly SessionPermissionMode[] = ['default', 'bypassPermissions']

/** GET /api/version — the repo's version.json read from disk at request time (update detection). */
export type VersionInfo = { version: string; notes: string[] }

export type SessionSummary = {
  id: string
  projectId: string
  name: string | null
  updatedAt: string
  messageCount: number
  isDraft: boolean
  model: string
  /** null — the user has not answered the per-session permissions question yet (UI must ask). */
  permissionMode: SessionPermissionMode | null
}

export type ChatMessage =
  | { role: 'user'; text: string; at: string }
  | { role: 'assistant'; text: string; at: string }
  | { role: 'tool'; toolUseId: string; kind: ToolKind; summary: string; ok: boolean; file?: string; line?: number; diffstat?: { added: number; removed: number }; at: string }

// ── WS client → server ──
/** The three answers to a permission_request — 'always' also persists an AlwaysRule. */
export type PermissionDecision = 'allow' | 'deny' | 'always'

export type ClientMessage =
  | { type: 'user_message'; text: string }
  | { type: 'permission_response'; requestId: string; decision: PermissionDecision }
  | { type: 'abort' }

// ── WS server → client ──
export type PermissionRequest = {
  type: 'permission_request'
  requestId: string
  toolName: string
  rendered: string
  /** null when no safe rule can be derived (unknown tools) — the UI then hides the "Always" button. */
  proposedRule: ProposedRule | null
}

export type ServerEvent =
  | { type: 'assistant_delta'; sessionId: string; text: string }
  | { type: 'tool_use'; sessionId: string; toolUseId: string; kind: ToolKind; summary: string; file?: string; line?: number; diffstat?: { added: number; removed: number } }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; ok: boolean; summary: string }
  | (PermissionRequest & { sessionId: string })
  | { type: 'usage'; sessionId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  | { type: 'status'; sessionId: string; state: 'idle' | 'streaming' | 'error'; error?: { reason: string; resetAt?: string }; partialText?: string; mapping?: { draftId: string; sessionId: string } }

const SERVER_EVENT_TYPES = new Set(['assistant_delta', 'tool_use', 'tool_result', 'permission_request', 'usage', 'status'])
const CLIENT_MESSAGE_TYPES = new Set(['user_message', 'permission_response', 'abort'])

export function isServerEvent(value: unknown): value is ServerEvent {
  return isRecordWithType(value, SERVER_EVENT_TYPES)
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const value = JSON.parse(raw)
    return isRecordWithType(value, CLIENT_MESSAGE_TYPES) ? (value as ClientMessage) : null
  } catch {
    return null
  }
}

function isRecordWithType(value: unknown, types: Set<string>): boolean {
  return typeof value === 'object' && value !== null && 'type' in value && types.has((value as { type: string }).type)
}
