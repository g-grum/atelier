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

// ── QCM (spec 2026-07-31-ask-user-question-qcm) ──
/** Miroir de AskUserQuestionInput.questions[] (SDK sdk-tools.d.ts). */
export type QcmOption = { label: string; description: string; preview?: string }
export type QcmQuestion = { question: string; header: string; options: QcmOption[]; multiSelect: boolean }

export const MODELS = ['claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-4-6'] as const

export type Project = { id: string; path: string; color: string }
/** GET /api/projects/:id/github-account — the GitHub account a project pushes as (derived from its `origin` remote), with its owner/repo. Both null when the project has no GitHub origin. */
export type ProjectGithubAccount = { account: string | null; repo: string | null }
/** REST shape of GET/POST /api/projects. The persisted Project stays count-free — a derived count goes stale instantly, so the routes enrich through SessionsService.countSessions at response time; never persist it. */
export type ProjectSummary = Project & { sessionCount: number }
/** Listing des fichiers d'un projet — l'autocomplétion @ du composer (spec 2026-08-12). */
export type ProjectFileList = { files: string[]; dirs: string[] }
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
  /** Mode appliqué aux NOUVELLES sessions (stampé dans createDraft). Absent/null = demander à chaque session (gate). Jamais rétroactif. */
  defaultPermissionMode?: SessionPermissionMode | null
}

/** One recorded usage sample (REST: GET /api/usage/history). All four counters persist — the forecast's fidelity depends on cache counts; a lossy total can't be backfilled. */
export type UsageEvent = { at: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }

/**
 * Per-session permission behavior for SDK turns. 'bypassPermissions' est un
 * auto-allow sélectif dans canUseTool (tout sauf AskUserQuestion — le QCM
 * remonte toujours à la UI) ; le mode SDK 'bypassPermissions' n'est plus utilisé.
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

/**
 * Une slash command proposée à l'autocomplétion. `name` est SANS le slash
 * initial (contrat SDK). `aliases` porte les noms courts des commandes
 * namespacées (`superpowers:brainstorming` → `brainstorming`) : le filtrage
 * DOIT les inclure, sinon les commandes de plugins sont introuvables.
 */
export type SlashCommandInfo = { name: string; description: string; argumentHint: string; aliases: string[] }

// ── WS client → server ──
/** The three answers to a permission_request — 'always' also persists an AlwaysRule. */
export type PermissionDecision = 'allow' | 'deny' | 'always'

export type ClientMessage =
  | { type: 'user_message'; text: string }
  | { type: 'permission_response'; requestId: string; decision: PermissionDecision }
  | { type: 'abort' }
  /** answers ABSENT = « répondu en texte » (dismiss). Multi-select : valeurs jointes par virgule. « Autre » : le texte libre est la valeur. */
  | { type: 'question_response'; requestId: string; answers?: Record<string, string> }

// ── WS server → client ──
export type PermissionRequest = {
  type: 'permission_request'
  requestId: string
  toolName: string
  rendered: string
  /** null when no safe rule can be derived (unknown tools) — the UI then hides the "Always" button. */
  proposedRule: ProposedRule | null
}

export type QuestionRequest = {
  type: 'question_request'
  requestId: string
  questions: QcmQuestion[]
}

export type ServerEvent =
  | { type: 'assistant_delta'; sessionId: string; text: string }
  | { type: 'tool_use'; sessionId: string; toolUseId: string; kind: ToolKind; summary: string; file?: string; line?: number; diffstat?: { added: number; removed: number } }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; ok: boolean; summary: string }
  | (PermissionRequest & { sessionId: string })
  | (QuestionRequest & { sessionId: string })
  | { type: 'usage'; sessionId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  | { type: 'rate_limit'; sessionId: string; limit: RateLimitSnapshot }
  | { type: 'status'; sessionId: string; state: 'idle' | 'streaming' | 'error'; error?: { reason: string; resetAt?: string }; partialText?: string; mapping?: { draftId: string; sessionId: string } }
  | { type: 'commands'; sessionId: string; commands: SlashCommandInfo[] }

const SERVER_EVENT_TYPES = new Set(['assistant_delta', 'tool_use', 'tool_result', 'permission_request', 'question_request', 'usage', 'rate_limit', 'status', 'commands'])
const CLIENT_MESSAGE_TYPES = new Set(['user_message', 'permission_response', 'abort', 'question_response'])

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

// ── Status hub (spec 2026-08-02) : canal WS séparé /api/sessions-status ──
export type SessionState = 'idle' | 'streaming' | 'error'
/** Diffusé par le hub à chaque transition d'état d'une session (et en snapshot à la connexion). Volontairement HORS de ServerEvent : le socket de session et son réducteur ne le voient jamais. */
export type SessionStatusEvent = { type: 'session_status'; sessionId: string; state: SessionState }

const SESSION_STATES = new Set<SessionState>(['idle', 'streaming', 'error'])

export function parseSessionStatus(raw: string): SessionStatusEvent | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (v?.type !== 'session_status' || typeof v.sessionId !== 'string' || !SESSION_STATES.has(v.state as SessionState)) return null
    return { type: 'session_status', sessionId: v.sessionId, state: v.state as SessionState }
  } catch {
    return null
  }
}

// ── Autopilot (spec 2026-08-05) ──
export type AutopilotItemStatus = 'queued' | 'running' | 'pr_opened' | 'reviewing' | 'fixing' | 'merging' | 'merged' | 'failed'
export type AutopilotRunState = 'running' | 'stopping'
export type AutopilotItem = {
  issue: number
  title: string
  branch: string
  /** Projet Atelier temporaire pointant sur le worktree. */
  projectId: string
  /** Racine du repo CIBLE (path du projet lancé) — indispensable au cleanup : le run est null à ce moment-là et le path du projet temporaire est le worktree, pas le repo. */
  repoRoot: string
  /** Id de session — draft d'abord, ré-écrit avec l'id SDK après matérialisation. */
  sessionId: string
  /** Session de review (niveau 2) — draft d'abord, ré-écrit avec l'id SDK après matérialisation. */
  reviewSessionId?: string
  status: AutopilotItemStatus
  prUrl?: string
  error?: string
  startedAt?: string
  endedAt?: string
}
/** run: null = idle. items = dernier run (remplacés au start suivant). lastError = échec du démarrage de la boucle (fetch issues), effacé au start suivant. */
export type AutopilotState = {
  run: { state: AutopilotRunState; startedAt: string; maxItems: number; projectId: string } | null
  items: AutopilotItem[]
  lastError?: string
}
/** Diffusé sur le hub /api/sessions-status à chaque mutation d'état autopilot. */
export type AutopilotStatusEvent = { type: 'autopilot_status'; autopilot: AutopilotState }
// ── Session artifacts & dev servers (2026-08-14) ──
/** Image produced by a tool call during a session — `path` is relative to the project root. */
export type SessionArtifact = { path: string; addedAt: string }
/** Broadcast on the status hub whenever a session's artifact list changes. Images are served by GET /api/projects/:id/artifacts?path=<rel>. */
export type ArtifactsStatusEvent = { type: 'artifacts_status'; sessionId: string; projectId: string; artifacts: SessionArtifact[] }
/** A TCP server listening locally while a session runs. `killable` = descendant of an Atelier session process (safe to stop). */
export type DevServer = { port: number; pid: number; label: string; command: string; killable: boolean }
/** Broadcast on the status hub on every dev-server scan diff. */
export type DevServersStatusEvent = { type: 'dev_servers_status'; servers: DevServer[] }

export type StatusHubEvent = SessionStatusEvent | AutopilotStatusEvent | ArtifactsStatusEvent | DevServersStatusEvent

export function parseStatusHubEvent(raw: string): StatusHubEvent | null {
  const session = parseSessionStatus(raw)
  if (session !== null) return session
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (v?.type === 'autopilot_status' && typeof v.autopilot === 'object' && v.autopilot !== null) {
      return { type: 'autopilot_status', autopilot: v.autopilot as AutopilotState }
    }
    if (v?.type === 'artifacts_status' && typeof v.sessionId === 'string' && typeof v.projectId === 'string' && Array.isArray(v.artifacts)) {
      return { type: 'artifacts_status', sessionId: v.sessionId, projectId: v.projectId, artifacts: v.artifacts as SessionArtifact[] }
    }
    if (v?.type === 'dev_servers_status' && Array.isArray(v.servers)) {
      return { type: 'dev_servers_status', servers: v.servers as DevServer[] }
    }
    return null
  } catch {
    return null
  }
}

// ── Widget dashboard (spec 2026-07-21) ──
export type WidgetType = 'github-prs' | 'rate-limits' | 'modified-files' | 'autopilot' | 'session-visuals' | 'dev-servers'
export type WidgetHeight = 'S' | 'M' | 'L'
/** Union par type de widget — consommateurs : narrowing STRUCTUREL (`'repo' in config`), le `type` du widget ne narrowe pas `config`. */
export type GithubPrsConfig = { repo: string; limit?: number }
export type AutopilotConfig = { projectId: string; maxItems?: number }
export type WidgetInstance = {
  /** uuid, unique in the array (array order = display order) */
  id: string
  type: WidgetType
  /** grid columns occupied (the dash grid has 2 columns) */
  span: 1 | 2
  /** fixed height tier — content scrolls internally */
  height: WidgetHeight
  /** github-prs: repo REQUIS ; autopilot: projectId REQUIS ; autres types: absente (validation PUT). */
  config?: GithubPrsConfig | AutopilotConfig
}

/** Types that may appear at most once in a layout. */
export const SINGLETON_WIDGET_TYPES: readonly WidgetType[] = ['rate-limits', 'modified-files', 'autopilot', 'session-visuals', 'dev-servers']

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
