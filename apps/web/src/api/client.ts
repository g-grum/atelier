import type { AlwaysRule, ChatMessage, Preferences, ProjectSummary, SessionSummary } from '@atelier/shared'

// ── Auth token ──
// Read from location.search ONCE at startup and persisted to sessionStorage so
// a reload (which loses the ?token= URL in SPA navigation) keeps the session.
// A token present in the URL always wins over a stored one (fresh app launch).

const TOKEN_KEY = 'atelier.token'

function initToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('token')
  if (fromUrl !== null) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl)
    return fromUrl
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? ''
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
  if (!response.ok) throw new ApiError(response.status, `${method} /api${path} → ${response.status}`)
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

export function patchSession(sessionId: string, patch: { name?: string; model?: string }): Promise<void> {
  return request<void>('PATCH', `/sessions/${encodeURIComponent(sessionId)}`, patch)
}

export function deleteSession(sessionId: string): Promise<void> {
  return request<void>('DELETE', `/sessions/${encodeURIComponent(sessionId)}`)
}

// ── Preferences ──

export function getPreferences(): Promise<Preferences> {
  return request<Preferences>('GET', '/preferences')
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
