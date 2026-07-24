import type { ChatMessage, ClientMessage, Preferences, PrSummary, ProjectSummary, RateLimitSnapshot, ServerEvent, SessionPermissionMode, SessionSummary, VersionInfo, WidgetInstance } from '@atelier/shared'
import type { ControllerSocket } from '../state/session-controller'
import { fixtureMessages, fixturePrs, fixtureProjects, fixtureSessions, fixtureTurn, fixtureWidgets } from '../state/fixtures'
import * as client from './client'
import { SessionSocket } from './ws'
import currentVersion from '../../../../version.json'

/**
 * Everything the app needs from a data source. `VITE_USE_FIXTURES` swaps the
 * real REST+WS clients for an in-memory replay of src/state/fixtures.ts
 * (component development + the seed of the demo mode). Default dev = real.
 */
export type Backend = {
  listProjects: () => Promise<ProjectSummary[]>
  registerProject: (path: string) => Promise<ProjectSummary>
  listSessions: (projectId: string) => Promise<SessionSummary[]>
  createDraft: (projectId: string, init?: { name?: string; model?: string }) => Promise<SessionSummary>
  getMessages: (sessionId: string) => Promise<ChatMessage[]>
  patchSession: (sessionId: string, patch: { name?: string; model?: string; permissionMode?: SessionPermissionMode }) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  openInIde: (args: { file: string; line?: number }) => Promise<{ ok: true } | { ok: false; reason: string }>
  createSocket: (sessionId: string, projectId: string) => ControllerSocket
  /** Repo-current version (server reads version.json from disk) — drives the update toast. */
  getVersion: () => Promise<VersionInfo>
  /** Last-known plan limits (five_hour, seven_day, …) — the claude.ai/usage gauges. */
  getUsageLimits: () => Promise<RateLimitSnapshot[]>
  /** Dashboard layout (array order = display order). */
  getWidgets: () => Promise<WidgetInstance[]>
  /** Atomic whole-array replacement — resolves to the stored layout. */
  putWidgets: (widgets: WidgetInstance[]) => Promise<WidgetInstance[]>
  /** Latest PRs of a repo through the server's gh proxy. */
  getGithubPrs: (repo: string, limit: number) => Promise<PrSummary[]>
  /** Persisted user preferences (theme, IDE, budgets…) — the boot theme resync reads this. */
  getPreferences: () => Promise<Preferences>
  /** Partial update of the preferences store — resolves to the merged result. */
  patchPreferences: (patch: Partial<Preferences>) => Promise<Preferences>
}

const realBackend: Backend = {
  listProjects: client.listProjects,
  registerProject: client.registerProject,
  listSessions: client.listSessions,
  createDraft: client.createDraft,
  getMessages: client.getMessages,
  patchSession: async (sessionId, patch) => {
    await client.patchSession(sessionId, patch)
  },
  deleteSession: client.deleteSession,
  openInIde: client.openInIde,
  createSocket: (sessionId, projectId) => new SessionSocket(sessionId, projectId),
  getVersion: client.getVersion,
  getUsageLimits: client.getUsageLimits,
  getWidgets: client.getWidgets,
  putWidgets: client.putWidgets,
  getGithubPrs: client.getGithubPrs,
  getPreferences: client.getPreferences,
  patchPreferences: client.patchPreferences,
}

// ── Fixture backend ──
// In-memory stores seeded from the fixtures module (never mutates the module's
// exported arrays — tests replay them too). History is static: a replayed turn
// is not persisted, and re-sending replays the same scripted turn (its
// duplicate toolUseId / requestId are absorbed by the reducer's dedupe).

const REPLAY_STEP_MS = 250

function createFixtureBackend(): Backend {
  let projects: ProjectSummary[] = fixtureProjects.map((project) => ({ ...project }))
  let sessions: SessionSummary[] = fixtureSessions.map((session) => ({ ...session }))
  const messages = new Map<string, ChatMessage[]>(Object.entries(fixtureMessages))
  let widgets: WidgetInstance[] = fixtureWidgets.map((w) => ({ ...w }))
  let nextId = 1

  return {
    listProjects: async () => projects,
    registerProject: async (path) => {
      // A folder registered in demo mode has no replayable history → count 0.
      const project: ProjectSummary = { id: `proj-${nextId++}`, path, color: 'cyan', sessionCount: 0 }
      projects = [...projects, project]
      return project
    },
    listSessions: async (projectId) => sessions.filter((session) => session.projectId === projectId),
    createDraft: async (projectId, init = {}) => {
      const draft: SessionSummary = {
        id: `draft-${nextId++}`,
        projectId,
        name: init.name ?? null,
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        isDraft: true,
        model: init.model ?? sessions[0]?.model ?? 'claude-fable-5',
        // A fresh session must ask the permissions question (spec) — demo mode included.
        permissionMode: null,
      }
      sessions = [...sessions, draft]
      return draft
    },
    getMessages: async (sessionId) => messages.get(sessionId) ?? [],
    patchSession: async (sessionId, patch) => {
      sessions = sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              name: patch.name ?? session.name,
              model: patch.model ?? session.model,
              permissionMode: patch.permissionMode ?? session.permissionMode,
            }
          : session,
      )
    },
    deleteSession: async (sessionId) => {
      sessions = sessions.filter((session) => session.id !== sessionId)
    },
    openInIde: async () => ({ ok: true }),
    createSocket: (sessionId) => new FixtureSocket(sessionId),
    // Demo mode is always "up to date" — the toast never fires under fixtures.
    getVersion: async () => currentVersion,
    // Plausible demo gauges — the same shape a real turn records.
    getUsageLimits: async () => [
      { window: 'five_hour', utilization: 34, status: 'allowed', resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), recordedAt: new Date().toISOString() },
      { window: 'seven_day', utilization: 61, status: 'allowed', resetsAt: new Date(Date.now() + 4 * 86400_000).toISOString(), recordedAt: new Date().toISOString() },
      { window: 'seven_day_opus', utilization: 12, status: 'allowed', resetsAt: new Date(Date.now() + 4 * 86400_000).toISOString(), recordedAt: new Date().toISOString() },
    ],
    getWidgets: async () => widgets,
    putWidgets: async (next) => {
      widgets = next.map((w) => ({ ...w }))
      return widgets
    },
    getGithubPrs: async (_repo, limit) => fixturePrs.slice(0, limit),
    // No `theme` key → demo mode defaults to dark (spec: clé absente = dark).
    getPreferences: async () => ({ ide: 'webstorm', defaultModel: 'claude-fable-5', windowBudgetTokens: 2_000_000, weeklyBudgetTokens: 12_000_000, githubUser: 'alice-dev' }),
    patchPreferences: async (patch) => ({ ide: 'webstorm', defaultModel: 'claude-fable-5', windowBudgetTokens: 2_000_000, weeklyBudgetTokens: 12_000_000, githubUser: 'alice-dev', ...patch }),
  }
}

/** Replays the scripted fixture turn on every user_message; abort cuts it short. */
class FixtureSocket implements ControllerSocket {
  private readonly handlers = new Set<(event: ServerEvent) => void>()
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(private readonly sessionId: string) {
    // Connect snapshot, delivered after the controller registered its handler.
    this.schedule(() => this.emit({ type: 'status', sessionId: this.sessionId, state: 'idle' }), 0)
  }

  on(handler: (event: ServerEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  onReconnect(): () => void {
    return () => {} // the fixture socket never drops
  }

  send(message: ClientMessage): void {
    if (message.type === 'user_message') {
      fixtureTurn.forEach((event, index) => {
        this.schedule(() => this.emit({ ...event, sessionId: this.sessionId }), (index + 1) * REPLAY_STEP_MS)
      })
    } else if (message.type === 'abort') {
      this.clearTimers()
      this.emit({ type: 'status', sessionId: this.sessionId, state: 'idle' })
    }
    // permission_response: the controller already resolved the item locally.
  }

  close(): void {
    this.clearTimers()
    this.handlers.clear()
  }

  private emit(event: ServerEvent): void {
    for (const handler of this.handlers) handler(event)
  }

  private schedule(fn: () => void, delayMs: number): void {
    this.timers.push(setTimeout(fn, delayMs))
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }
}

const useFixtures = Boolean(import.meta.env.VITE_USE_FIXTURES)

export const backend: Backend = useFixtures ? createFixtureBackend() : realBackend
