import { randomUUID } from 'node:crypto'
import type { AutopilotItem, AutopilotState, StatusHubEvent } from '@atelier/shared'
import type { GithubService } from '../github/github-service'
import type { SessionsService } from '../sessions/sessions-service'
import type { SessionStreamRegistry } from '../stream/session-stream'
import type { AppData } from '../store/app-data'
import { buildItemPrompt, buildRetryPrompt } from './item-prompt'
import type { WorkspaceFactory } from './workspace'

/** start() refusé : un run est déjà en cours (→ 409 côté route). */
export class AutopilotConflictError extends Error {
  constructor() {
    super('un run autopilot est déjà en cours')
    this.name = 'AutopilotConflictError'
  }
}

const DEFAULT_ITEM_TIMEOUT_MS = 30 * 60_000
/** Couleur des projets temporaires — l'indigo autopilot (l'ambre reste aux permissions). */
const TEMP_PROJECT_COLOR = '#6366f1'

type Deps = {
  data: AppData
  sessions: Pick<SessionsService, 'createDraft' | 'setPermissionMode'>
  streams: Pick<SessionStreamRegistry, 'get' | 'onStatusConnect' | 'onStatusClose' | 'publish'>
  github: Pick<GithubService, 'listAutopilotIssues' | 'prForBranch' | 'issueBody'>
  workspace: WorkspaceFactory
  itemTimeoutMs?: number
}

type TurnOutcome = 'idle' | 'error' | 'timeout'

/**
 * Orchestrateur du backlog autonome (spec 2026-08-05) : séquentiel, borné,
 * un worktree + un projet temporaire + une session réelle par issue, PR à
 * reviewer comme livrable. Toute mutation d'état est persistée ET publiée
 * sur le hub de statut.
 */
export class AutopilotRunner {
  private readonly data: AppData
  private readonly sessions: Deps['sessions']
  private readonly streams: Deps['streams']
  private readonly github: Deps['github']
  private readonly workspace: WorkspaceFactory
  private readonly itemTimeoutMs: number

  /** Attente de fin de tour de l'item courant — résolue par le sink du hub. */
  private waiter: { match: (sessionId: string) => boolean; resolve: (outcome: TurnOutcome) => void } | null = null
  private readonly sink = (event: StatusHubEvent): void => {
    if (event.type !== 'session_status' || event.state === 'streaming') return
    const waiter = this.waiter
    if (waiter && waiter.match(event.sessionId)) {
      this.waiter = null
      waiter.resolve(event.state)
    }
  }

  constructor({ data, sessions, streams, github, workspace, itemTimeoutMs }: Deps) {
    this.data = data
    this.sessions = sessions
    this.streams = streams
    this.github = github
    this.workspace = workspace
    this.itemTimeoutMs = itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS
  }

  start({ projectId, repo, githubUser, maxItems }: { projectId: string; repo: string; githubUser: string; maxItems: number }): void {
    if (this.data.get().autopilot.run !== null) throw new AutopilotConflictError()
    this.mutate((autopilot) => {
      autopilot.run = { state: 'running', startedAt: new Date().toISOString(), maxItems, projectId }
      autopilot.items = []
      delete autopilot.lastError
    })
    // Fire-and-forget : la route a déjà répondu 202 ; le run ne reste JAMAIS
    // bloqué en running — toute sortie de runLoop repasse run à null.
    void this.runLoop({ projectId, repo, githubUser, maxItems })
  }

  stop(): void {
    if (this.data.get().autopilot.run === null) return
    this.mutate((autopilot) => {
      if (autopilot.run !== null) autopilot.run.state = 'stopping'
    })
  }

  /** Nettoyage des items terminaux : worktree + branche + projet temporaire + item (action volontaire post-autopsie). */
  async cleanup(): Promise<void> {
    const terminal = this.data.get().autopilot.items.filter((i) => i.status === 'pr_opened' || i.status === 'failed')
    for (const item of terminal) {
      // repoRoot persisté sur l'item exprès : run null ici, et le path du projet temporaire est le worktree.
      await this.workspace(item.repoRoot).cleanup(item.issue)
    }
    const ids = new Set(terminal.map((i) => i.issue))
    const projectIds = new Set(terminal.map((i) => i.projectId))
    this.mutate((autopilot) => {
      autopilot.items = autopilot.items.filter((i) => !ids.has(i.issue))
    })
    this.data.update((d) => {
      d.projects = d.projects.filter((p) => !projectIds.has(p.id))
    })
  }

  private async runLoop({ projectId, repo, githubUser, maxItems }: { projectId: string; repo: string; githubUser: string; maxItems: number }): Promise<void> {
    this.streams.onStatusConnect(this.sink)
    try {
      const repoRoot = this.data.get().projects.find((p) => p.id === projectId)?.path ?? ''
      let issues: { number: number; title: string }[]
      try {
        issues = await this.github.listAutopilotIssues(repo, githubUser)
      } catch (err) {
        this.mutate((autopilot) => {
          autopilot.lastError = err instanceof Error ? err.message : String(err)
        })
        return
      }
      if (issues.length === 0) {
        this.mutate((autopilot) => {
          autopilot.lastError = 'aucune issue ouverte labellisée autopilot'
        })
        return
      }

      this.mutate((autopilot) => {
        autopilot.items = issues.slice(0, maxItems).map((issue) => ({
          issue: issue.number,
          title: issue.title,
          branch: `autopilot/${issue.number}`,
          projectId: '',
          repoRoot,
          sessionId: '',
          status: 'queued' as const,
        }))
      })

      for (const queued of this.data.get().autopilot.items) {
        if (this.data.get().autopilot.run?.state !== 'running') break
        const stopRun = await this.processItem(queued.issue, { repo, githubUser, repoRoot })
        if (stopRun) break
      }
    } finally {
      this.streams.onStatusClose(this.sink)
      this.waiter = null
      this.mutate((autopilot) => {
        autopilot.run = null
      })
    }
  }

  /** Traite un item de bout en bout. Retourne true si le RUN entier doit s'arrêter (rate limit). */
  private async processItem(issue: number, { repo, githubUser, repoRoot }: { repo: string; githubUser: string; repoRoot: string }): Promise<boolean> {
    this.updateItem(issue, (item) => {
      item.status = 'running'
      item.startedAt = new Date().toISOString()
    })
    try {
      const workspace = this.workspace(repoRoot)
      const { path, branch } = await workspace.prepare(issue)

      const tempProjectId = randomUUID()
      this.data.update((d) => {
        d.projects.push({ id: tempProjectId, path, color: TEMP_PROJECT_COLOR })
      })
      const item = this.getItem(issue)
      const draft = this.sessions.createDraft(tempProjectId, { name: `Autopilot #${issue}` })
      this.sessions.setPermissionMode(draft.id, 'bypassPermissions')
      this.updateItem(issue, (i) => {
        i.projectId = tempProjectId
        i.sessionId = draft.id
      })

      const body = await this.github.issueBody(repo, issue, githubUser)
      const stream = this.streams.get(draft.id, tempProjectId)
      stream.onMessage(JSON.stringify({ type: 'user_message', text: buildItemPrompt({ issue, title: item.title, body, branch }) }))

      let outcome = await this.waitForTurnEnd(issue, stream)
      if (outcome !== 'idle') return this.failItem(issue, outcome)

      let pr = await this.github.prForBranch(repo, branch, githubUser)
      if (pr === null && this.data.get().autopilot.run?.state === 'running') {
        // UNE relance, jamais plus — le tour s'est fini sans PR (spec).
        stream.onMessage(JSON.stringify({ type: 'user_message', text: buildRetryPrompt(issue) }))
        outcome = await this.waitForTurnEnd(issue, stream)
        if (outcome !== 'idle') return this.failItem(issue, outcome)
        pr = await this.github.prForBranch(repo, branch, githubUser)
      }

      this.updateItem(issue, (i) => {
        i.endedAt = new Date().toISOString()
        if (pr !== null) {
          i.status = 'pr_opened'
          i.prUrl = pr.url
        } else {
          i.status = 'failed'
          i.error = 'le tour s’est terminé sans PR ouverte'
        }
      })
      return false
    } catch (err) {
      this.updateItem(issue, (i) => {
        i.status = 'failed'
        i.error = err instanceof Error ? err.message : String(err)
        i.endedAt = new Date().toISOString()
      })
      return false
    }
  }

  /** Marque l'item failed selon l'issue de tour non-idle. Retourne true si le run doit s'arrêter (rate limit encore valide). */
  private failItem(issue: number, outcome: Exclude<TurnOutcome, 'idle'>): boolean {
    this.updateItem(issue, (i) => {
      i.status = 'failed'
      i.error = outcome === 'timeout' ? `timeout (${Math.round(this.itemTimeoutMs / 60_000)} min)` : 'la session a terminé en erreur'
      i.endedAt = new Date().toISOString()
    })
    if (outcome !== 'error') return false
    // Le hub ne transporte pas resetAt : on lit les fenêtres de plan persistées.
    // Un rejet ENCORE valide ⇒ inutile d'enchaîner des items sans quota.
    const now = Date.now()
    return Object.values(this.data.get().rateLimits).some(
      (s) => s.status === 'rejected' && (s.resetsAt === undefined || Date.parse(s.resetsAt) > now)
    )
  }

  /**
   * Attend la fin du tour de l'item : transition hub → idle/error de SA session
   * (remap draft→SDK suivi via resolveSessionId, item.sessionId réécrit au passage),
   * ou timeout → abort de la session. La garde `status === 'running'` du sink est
   * assurée par waiter/null : un idle tardif post-timeout ne re-déclenche rien.
   */
  private waitForTurnEnd(issue: number, stream: { onMessage: (raw: string) => void }): Promise<TurnOutcome> {
    return new Promise<TurnOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter === null) return
        this.waiter = null
        stream.onMessage(JSON.stringify({ type: 'abort' }))
        resolve('timeout')
      }, this.itemTimeoutMs)
      this.waiter = {
        match: (sessionId) => {
          const item = this.getItem(issue)
          const resolved = this.data.resolveSessionId(item.sessionId)
          if (sessionId !== resolved) return false
          if (item.sessionId !== resolved) {
            this.updateItem(issue, (i) => {
              i.sessionId = resolved
            })
          }
          return true
        },
        resolve: (outcome) => {
          clearTimeout(timer)
          resolve(outcome)
        },
      }
    })
  }

  private getItem(issue: number): AutopilotItem {
    const item = this.data.get().autopilot.items.find((i) => i.issue === issue)
    if (item === undefined) throw new Error(`item autopilot introuvable : #${issue}`)
    return item
  }

  private updateItem(issue: number, fn: (item: AutopilotItem) => void): void {
    this.mutate((autopilot) => {
      const item = autopilot.items.find((i) => i.issue === issue)
      if (item !== undefined) fn(item)
    })
  }

  /** Unique point de mutation : persiste puis publie l'état complet sur le hub. */
  private mutate(fn: (autopilot: AutopilotState) => void): void {
    this.data.update((d) => fn(d.autopilot))
    this.streams.publish({ type: 'autopilot_status', autopilot: this.data.get().autopilot })
  }
}
