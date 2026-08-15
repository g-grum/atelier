import type { AlwaysRule, AutopilotState, ChatMessage, ClientMessage, Preferences, ProjectFileList, ProjectGithubAccount, PrSummary, ProjectSummary, RateLimitSnapshot, ServerEvent, SessionPermissionMode, SessionSummary, SlashCommandInfo, StatusHubEvent, VersionInfo, WidgetInstance } from '@atelier/shared'
import type { ControllerSocket } from '../state/session-controller'
import { FIXTURE_PROJECT_ID, FIXTURE_SESSION_ID, fixtureArtifacts, fixtureAutopilot, fixtureDevServers, fixtureErrorTurn, fixtureMessages, fixturePrs, fixtureProjects, fixtureSessions, fixtureTurn, fixtureWidgets } from '../state/fixtures'
import * as client from './client'
import { StatusSocket } from './status-socket'
import { SessionSocket } from './ws'
import currentVersion from '../../../../version.json'

/** Public surface a status-hub socket must expose — StatusSocket's shape (receive-only, no send). */
export type StatusSocketLike = { close: () => void }

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
  /** GitHub account the given project pushes as (derived from its origin remote) — feeds the topbar chip. */
  getProjectGithubAccount: (projectId: string) => Promise<ProjectGithubAccount>
  /** Persisted user preferences (theme, IDE, budgets…) — the boot theme resync reads this. */
  getPreferences: () => Promise<Preferences>
  /** Partial update of the preferences store — resolves to the merged result. */
  patchPreferences: (patch: Partial<Preferences>) => Promise<Preferences>
  /** Slash commands du projet — alimente l'autocomplétion du composer. */
  listCommands: (projectId: string) => Promise<SlashCommandInfo[]>
  /** Fichiers du projet — alimente l'autocomplétion @ du composer. */
  listFiles: (projectId: string) => Promise<ProjectFileList>
  /** Upload d'une image dans le projet — l'agent la lit via Read. */
  uploadImage: (projectId: string, file: File) => Promise<{ path: string }>
  /** Règles « toujours autoriser » persistées — la section permissions des Réglages. */
  listRules: () => Promise<AlwaysRule[]>
  deleteRule: (id: string) => Promise<void>
  /** Désinscrit un projet (les sessions restent sur disque côté serveur). */
  deleteProject: (id: string) => Promise<void>
  /**
   * Status-hub socket (spec 2026-08-02) — a real WebSocket in production, a
   * closeable no-op under fixtures/tests. Kept behind this seam (like
   * `createSocket` above) so App never constructs `new StatusSocket(...)`
   * itself: a real WS in a jsdom/happy-dom test environment throws on an
   * unreachable connection (no server), crashing the whole suite.
   */
  createStatusSocket: (onEvent: (event: StatusHubEvent) => void) => StatusSocketLike
  /** État autopilot complet (run + items du dernier run). */
  getAutopilot: () => Promise<AutopilotState>
  /** Lance un run autopilot — rejette avec le message FR du serveur (400/404/409). */
  startAutopilot: (projectId: string, maxItems?: number) => Promise<void>
  stopAutopilot: () => Promise<void>
  /** Nettoie worktrees/branches/projets temporaires des items terminaux. */
  cleanupAutopilot: () => Promise<void>
  /**
   * Stops a killable dev server (POST /api/dev-servers/:pid/stop). The rows
   * themselves arrive through the status hub (dev_servers_status events) —
   * same push-only flow as autopilot_status.
   */
  stopDevServer: (pid: number) => Promise<void>
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
  getProjectGithubAccount: client.getProjectGithubAccount,
  getPreferences: client.getPreferences,
  patchPreferences: client.patchPreferences,
  listCommands: client.listCommands,
  listFiles: client.listFiles,
  uploadImage: client.uploadImage,
  listRules: client.listRules,
  deleteRule: client.deleteRule,
  deleteProject: client.deleteProject,
  createStatusSocket: (onEvent) => new StatusSocket(onEvent),
  getAutopilot: client.getAutopilot,
  startAutopilot: client.startAutopilot,
  stopAutopilot: client.stopAutopilot,
  cleanupAutopilot: client.cleanupAutopilot,
  stopDevServer: client.stopDevServer,
}

/** Baseline préférences (sans clé `theme` → dark) — partagé par le fixture et les tests, façon DEFAULT_WIDGETS. */
export const DEFAULT_PREFERENCES: Preferences = { ide: 'webstorm', defaultModel: 'claude-fable-5', windowBudgetTokens: 2_000_000, weeklyBudgetTokens: 12_000_000, githubUser: 'alice-dev' }

// ── Fixture backend ──
// In-memory stores seeded from the fixtures module (never mutates the module's
// exported arrays — tests replay them too). History is static: a replayed turn
// is not persisted, and re-sending replays the same scripted turn (its
// duplicate toolUseId / requestId are absorbed by the reducer's dedupe).

const REPLAY_STEP_MS = 250

/** Exported for tests — the module-level `backend` picks real vs fixture once at load. */
export function createFixtureBackend(): Backend {
  let projects: ProjectSummary[] = fixtureProjects.map((project) => ({ ...project }))
  // Règles « toujours autoriser » plausibles pour le mode démo (section Réglages).
  let rules: AlwaysRule[] = [
    { id: 'rule-1', projectId: 'proj-atelier', toolName: 'Bash', matcher: 'bun test' },
    { id: 'rule-2', projectId: 'proj-atelier', toolName: 'Read', matcher: null },
  ]
  let sessions: SessionSummary[] = fixtureSessions.map((session) => ({ ...session }))
  const messages = new Map<string, ChatMessage[]>(Object.entries(fixtureMessages))
  let widgets: WidgetInstance[] = fixtureWidgets.map((w) => ({ ...w }))
  let autopilot: AutopilotState = structuredClone(fixtureAutopilot)
  let devServers = fixtureDevServers.map((server) => ({ ...server }))
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
    // Demo mode: a plausible account so the topbar chip renders in fixtures.
    getProjectGithubAccount: async () => ({ account: 'alice-dev', repo: 'atelier/demo' }),
    // No `theme` key → demo mode defaults to dark (spec: clé absente = dark).
    getPreferences: async () => ({ ...DEFAULT_PREFERENCES }),
    patchPreferences: async (patch) => ({ ...DEFAULT_PREFERENCES, ...patch }),
    // Demo mode: aucune sonde SDK à disposition → pas d'autocomplétion.
    listCommands: async () => [],
    // Mode démo : pas de projet réel sur disque → pas d'autocomplétion fichiers.
    listFiles: async () => ({ files: [], dirs: [] }),
    // Mode démo : pas d'écriture disque réelle.
    uploadImage: async () => ({ path: '.atelier/uploads/demo.png' }),
    listRules: async () => rules,
    deleteRule: async (id) => {
      rules = rules.filter((rule) => rule.id !== id)
    },
    deleteProject: async (id) => {
      projects = projects.filter((project) => project.id !== id)
    },
    // Demo mode: no server-side hub — replay the artifacts + dev servers
    // snapshots once (async, after the subscriber registered) so both widgets
    // have data; session dots keep their default (idle/done) derivation.
    createStatusSocket: (onEvent) => {
      const timer = setTimeout(() => {
        onEvent({ type: 'artifacts_status', sessionId: FIXTURE_SESSION_ID, projectId: FIXTURE_PROJECT_ID, artifacts: fixtureArtifacts.map((a) => ({ ...a })) })
        onEvent({ type: 'dev_servers_status', servers: devServers.map((server) => ({ ...server })) })
      }, 0)
      return { close: () => clearTimeout(timer) }
    },
    // Autopilot de démo : start bascule le premier item en running, assez pour montrer la UI.
    getAutopilot: async () => structuredClone(autopilot),
    startAutopilot: async (projectId) => {
      autopilot = {
        run: { state: 'running', startedAt: new Date().toISOString(), maxItems: 3, projectId },
        items: fixtureAutopilot.items.map((item, i) => (i === 0 ? { ...item, status: 'running' as const, prUrl: undefined, endedAt: undefined } : { ...item })),
      }
    },
    stopAutopilot: async () => {
      autopilot = { run: null, items: autopilot.items.map((item) => ({ ...item })) }
    },
    cleanupAutopilot: async () => {
      autopilot = { run: autopilot.run, items: autopilot.items.filter((i) => i.status !== 'pr_opened' && i.status !== 'failed') }
    },
    // Demo stop: drop the row — the next hub replay (new socket) reflects it.
    stopDevServer: async (pid) => {
      devServers = devServers.filter((server) => server.pid !== pid)
    },
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
      // Mode démo : un message contenant « erreur »/« error » rejoue le tour
      // coupé par la limite d'usage (exerce l'ErrorBanner hors serveur réel).
      const turn = /erreur|error/i.test(message.text) ? fixtureErrorTurn : fixtureTurn
      turn.forEach((event, index) => {
        this.schedule(() => this.emit({ ...event, sessionId: this.sessionId }), (index + 1) * REPLAY_STEP_MS)
      })
    } else if (message.type === 'abort') {
      this.clearTimers()
      this.emit({ type: 'status', sessionId: this.sessionId, state: 'idle' })
    }
    // permission_response, question_response: the controller already resolved the item locally.
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
