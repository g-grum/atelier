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
export type Preferences = { ide: 'webstorm' | 'vscode' | 'cursor' | 'idea'; defaultModel: string }

export type SessionSummary = {
  id: string
  projectId: string
  name: string | null
  updatedAt: string
  messageCount: number
  isDraft: boolean
  model: string
}

export type ChatMessage =
  | { role: 'user'; text: string; at: string }
  | { role: 'assistant'; text: string; at: string }
  | { role: 'tool'; toolUseId: string; kind: ToolKind; summary: string; ok: boolean; file?: string; line?: number; diffstat?: { added: number; removed: number }; at: string }

// ── WS client → server ──
export type ClientMessage =
  | { type: 'user_message'; text: string }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' | 'always' }
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
