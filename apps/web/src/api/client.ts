import type { AlwaysRule, AutopilotState, ChatMessage, Preferences, ProjectFileList, ProjectGithubAccount, PrSummary, ProjectSummary, RateLimitSnapshot, SessionPermissionMode, SessionSummary, SlashCommandInfo, VersionInfo, WidgetInstance } from '@atelier/shared'

// ── Auth token ──
// Read from location.search ONCE at startup and persisted to sessionStorage so
// a reload (which loses the ?token= URL in SPA navigation) keeps the session.
// A token present in the URL always wins over a stored one (fresh app launch).
// Last resort in dev only: the token Vite compiled in (see vite.config.ts), so
// `bun run dev:web` works on a bare http://localhost:4518. It is `undefined` in
// production builds, where the Electron shell always supplies ?token=.

const TOKEN_KEY = 'atelier.token'

function initToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('token')
  if (fromUrl !== null) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl)
    return fromUrl
  }
  const stored = sessionStorage.getItem(TOKEN_KEY)
  if (stored !== null && stored !== '') return stored
  return import.meta.env.VITE_ATELIER_DEV_TOKEN ?? ''
}

const token = initToken()

/** The auth token for this app instance — also used by the WS client (?token= query param). */
export function getToken(): string {
  return token
}

// ── Fetch plumbing ──

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    // Surface the server's French { error } message when present — the PR
    // widget and the layout toast display it verbatim.
    let detail: string | null = null
    try {
      detail = ((await response.json()) as { error?: string }).error ?? null
    } catch {
      // non-JSON body — keep the generic message
    }
    throw new ApiError(response.status, detail ?? `${method} /api${path} → ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

// ── Projects ──

// GET/POST /api/projects respond with the ProjectSummary DTO (Project + sessionCount).
export function listProjects(): Promise<ProjectSummary[]> {
  return request<ProjectSummary[]>('GET', '/projects')
}

export function registerProject(path: string): Promise<ProjectSummary> {
  return request<ProjectSummary>('POST', '/projects', { path })
}

export function deleteProject(id: string): Promise<void> {
  return request<void>('DELETE', `/projects/${encodeURIComponent(id)}`)
}

// ── Sessions ──

export function listSessions(projectId: string): Promise<SessionSummary[]> {
  return request<SessionSummary[]>('GET', `/projects/${encodeURIComponent(projectId)}/sessions`)
}

export function createDraft(projectId: string, init: { name?: string; model?: string } = {}): Promise<SessionSummary> {
  return request<SessionSummary>('POST', `/projects/${encodeURIComponent(projectId)}/sessions`, init)
}

export function getMessages(sessionId: string): Promise<ChatMessage[]> {
  return request<ChatMessage[]>('GET', `/sessions/${encodeURIComponent(sessionId)}/messages`)
}

export function patchSession(sessionId: string, patch: { name?: string; model?: string; permissionMode?: SessionPermissionMode }): Promise<void> {
  return request<void>('PATCH', `/sessions/${encodeURIComponent(sessionId)}`, patch)
}

export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await request<void>('DELETE', `/sessions/${encodeURIComponent(sessionId)}`)
  } catch (err) {
    // A 404 on DELETE means the session is already gone (double-clicked draft ×,
    // deleted from the CLI) — that IS the requested outcome, not a failure.
    if (err instanceof ApiError && err.status === 404) return
    throw err
  }
}

// ── Preferences ──

export function getPreferences(): Promise<Preferences> {
  return request<Preferences>('GET', '/preferences')
}

// ── Usage limits ──

/** Last-known plan limit per window — the claude.ai/usage numbers, recorded from SDK turns. */
export function getUsageLimits(): Promise<RateLimitSnapshot[]> {
  return request<RateLimitSnapshot[]>('GET', '/usage/limits')
}

// ── Version ──

/** The repo's current version.json (read server-side from disk) — update detection. */
export function getVersion(): Promise<VersionInfo> {
  return request<VersionInfo>('GET', '/version')
}

export function patchPreferences(patch: Partial<Preferences>): Promise<Preferences> {
  return request<Preferences>('PATCH', '/preferences', patch)
}

// ── Rules ──

export function listRules(): Promise<AlwaysRule[]> {
  return request<AlwaysRule[]>('GET', '/rules')
}

export function deleteRule(id: string): Promise<void> {
  return request<void>('DELETE', `/rules/${encodeURIComponent(id)}`)
}

// ── IDE ──

/** Always resolves with { ok } — the server never 500s here; `reason` feeds the toast. */
export function openInIde(args: { file: string; line?: number }): Promise<{ ok: true } | { ok: false; reason: string }> {
  return request<{ ok: true } | { ok: false; reason: string }>('POST', '/open-in-ide', args)
}

// ── Widgets ──

export function getWidgets(): Promise<WidgetInstance[]> {
  return request<WidgetInstance[]>('GET', '/widgets')
}

export function putWidgets(widgets: WidgetInstance[]): Promise<WidgetInstance[]> {
  return request<WidgetInstance[]>('PUT', '/widgets', widgets)
}

// ── GitHub ──

export function getGithubPrs(repo: string, limit: number): Promise<PrSummary[]> {
  return request<PrSummary[]>('GET', `/github/prs?repo=${encodeURIComponent(repo)}&limit=${limit}`)
}

/** The GitHub account the given project pushes as (derived server-side from its origin remote). */
export function getProjectGithubAccount(projectId: string): Promise<ProjectGithubAccount> {
  return request<ProjectGithubAccount>('GET', `/projects/${encodeURIComponent(projectId)}/github-account`)
}

// ── Slash commands ──

/**
 * Slash commands disponibles dans le projet. Le serveur ouvre une sonde SDK
 * jetable pour les découvrir : ~3,8 s au premier appel, d'où le cache long
 * côté appelant (react-query).
 */
export function listCommands(projectId: string): Promise<SlashCommandInfo[]> {
  return request<SlashCommandInfo[]>('GET', `/projects/${encodeURIComponent(projectId)}/commands`)
}

/** Fichiers + dossiers du projet — l'autocomplétion @ du composer. */
export function listFiles(projectId: string): Promise<ProjectFileList> {
  return request<ProjectFileList>('GET', `/projects/${encodeURIComponent(projectId)}/files`)
}

/** Upload d'une image dans le projet (multipart) — répond { path } relatif. */
export async function uploadImage(projectId: string, file: File): Promise<{ path: string }> {
  const form = new FormData()
  form.append('file', file)
  // Pas de Content-Type manuel : le navigateur pose le boundary multipart.
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (!response.ok) {
    let detail: string | null = null
    try { detail = ((await response.json()) as { error?: string }).error ?? null } catch { /* non-JSON */ }
    throw new ApiError(response.status, detail ?? `POST /uploads → ${response.status}`)
  }
  return (await response.json()) as { path: string }
}

// ── Autopilot (spec 2026-08-05) ──

/** Stops a dev server Atelier started (POST → 204; 403 = not killable, 404 = gone). */
export function stopDevServer(pid: number): Promise<void> {
  return request('POST', `/dev-servers/${pid}/stop`)
}

export function getAutopilot(): Promise<AutopilotState> {
  return request<AutopilotState>('GET', '/autopilot')
}

export function startAutopilot(projectId: string, maxItems?: number): Promise<void> {
  return request<{ ok: true }>('POST', '/autopilot/start', { projectId, ...(maxItems !== undefined ? { maxItems } : {}) }).then(() => undefined)
}

export function stopAutopilot(): Promise<void> {
  return request<{ ok: true }>('POST', '/autopilot/stop').then(() => undefined)
}

export function cleanupAutopilot(): Promise<void> {
  return request<{ ok: true }>('POST', '/autopilot/cleanup').then(() => undefined)
}
