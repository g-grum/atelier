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
export type Theme = 'dark' | 'light'
export const THEMES: readonly Theme[] = ['dark', 'light']

export type Preferences = {
  ide: 'webstorm' | 'vscode' | 'cursor' | 'idea'
  defaultModel: string
  /** Calibratable 5h-window token budget — an ESTIMATE (no public API exposes plan limits); the store guarantees a default. */
  windowBudgetTokens: number
  /** Calibratable weekly (trailing 7 days) token budget — same estimate policy as windowBudgetTokens. */
  weeklyBudgetTokens: number
  /** gh CLI keyring account used by the GitHub proxy — pinned so the active-account switch (atelier release ops) never breaks the PR widget. */
  githubUser: string
  /** Thème UI. Clé absente = dark (rétrocompat disque, spec charte v5). */
  theme?: Theme
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

// ── Plan rate limits (the claude.ai/usage numbers) ──
/** The subscription windows the SDK reports through rate_limit_events. */
export type RateLimitWindow = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage'

/** Last-known state of one plan window — REAL account-wide data from the SDK, never an estimate. */
export type RateLimitSnapshot = {
  window: RateLimitWindow
  /** Percent, 0–100 (the SDK reports a 0–1 fraction; the server normalizes). */
  utilization: number
  status: 'allowed' | 'allowed_warning' | 'rejected'
  /** ISO date — when the window resets. */
  resetsAt?: string
  /** ISO date — when this snapshot was observed (turn time). */
  recordedAt: string
}

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
  | { type: 'rate_limit'; sessionId: string; limit: RateLimitSnapshot }
  | { type: 'status'; sessionId: string; state: 'idle' | 'streaming' | 'error'; error?: { reason: string; resetAt?: string }; partialText?: string; mapping?: { draftId: string; sessionId: string } }

const SERVER_EVENT_TYPES = new Set(['assistant_delta', 'tool_use', 'tool_result', 'permission_request', 'usage', 'rate_limit', 'status'])
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

// ── Widget dashboard (spec 2026-07-21) ──
export type WidgetType = 'github-prs' | 'rate-limits' | 'modified-files'
export type WidgetHeight = 'S' | 'M' | 'L'
export type WidgetInstance = {
  /** uuid, unique in the array (array order = display order) */
  id: string
  type: WidgetType
  /** grid columns occupied (the dash grid has 2 columns) */
  span: 1 | 2
  /** fixed height tier — content scrolls internally */
  height: WidgetHeight
  /** github-prs: REQUIRED (repo); other types: must be absent (PUT validation enforces both) */
  config?: { repo: string; limit?: number }
}

/** Types that may appear at most once in a layout. */
export const SINGLETON_WIDGET_TYPES: readonly WidgetType[] = ['rate-limits', 'modified-files']

/** owner/repo — shared by PUT /api/widgets, GET /api/github/prs and the config dialog. Anchored: no slashes inside segments, no query strings. */
export const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/

/**
 * Single source for the server default AND the web fallback (spec: they must
 * not drift). Mirrors the pre-dashboard aside. NEVER mutate — consumers clone.
 */
export const DEFAULT_WIDGETS: readonly WidgetInstance[] = [
  { id: 'default-rate-limits', type: 'rate-limits', span: 2, height: 'M' },
  { id: 'default-modified-files', type: 'modified-files', span: 2, height: 'M' },
]

// ── GitHub PRs (spec 2026-07-21) ──
export type PrState = 'open' | 'merged' | 'closed' | 'draft'
export type PrCi = 'passed' | 'failed' | 'pending' | null
export type PrReview = 'approved' | 'changes_requested' | 'required' | null
/** REST shape of GET /api/github/prs — one entry per PR, newest activity first. */
export type PrSummary = {
  number: number
  title: string
  url: string
  author: string
  state: PrState
  updatedAt: string
  branch: string
  ci: PrCi
  review: PrReview
}
