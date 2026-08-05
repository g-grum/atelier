import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatusHubEvent } from '@atelier/shared'
import { AppData } from '../store/app-data'
import { AutopilotConflictError, AutopilotRunner } from './autopilot-runner'
import type { Workspace } from './workspace'

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function makeDeps(overrides: {
  issues?: { number: number; title: string }[] | (() => Promise<{ number: number; title: string }[]>)
  prs?: Array<{ number: number; url: string } | null>
  prepareError?: string
} = {}) {
  const data = new AppData(join(mkdtempSync(join(tmpdir(), 'atelier-ap-')), 'data.json'))
  data.update((d) => {
    d.projects.push({ id: 'p1', path: '/repo', color: 'cyan' })
  })

  let draftCount = 0
  const sessions = {
    createDraft: (projectId: string, init: { name?: string } = {}) => {
      draftCount += 1
      const id = `draft-${draftCount}`
      data.update((d) => {
        d.drafts.push({ id, projectId, name: init.name ?? null, model: 'claude-fable-5', createdAt: new Date().toISOString() })
      })
      return { id, projectId, name: init.name ?? null, updatedAt: '', messageCount: 0, isDraft: true, model: 'claude-fable-5', permissionMode: null }
    },
    setPermissionMode: (id: string, mode: string) => {
      permissionCalls.push({ id, mode })
    },
  }
  const permissionCalls: { id: string; mode: string }[] = []

  const messages: { sessionId: string; raw: string }[] = []
  const hubSinks = new Set<(e: StatusHubEvent) => void>()
  const published: StatusHubEvent[] = []
  const streams = {
    get: (id: string, _projectId: string) => ({
      onMessage: (raw: string) => messages.push({ sessionId: id, raw }),
    }),
    onStatusConnect: (send: (e: StatusHubEvent) => void) => {
      hubSinks.add(send)
    },
    onStatusClose: (send: (e: StatusHubEvent) => void) => {
      hubSinks.delete(send)
    },
    publish: (event: StatusHubEvent) => {
      published.push(event)
      for (const send of hubSinks) send(event)
    },
  }
  const emit = (sessionId: string, state: 'idle' | 'streaming' | 'error') => {
    for (const send of hubSinks) send({ type: 'session_status', sessionId, state })
  }

  const prQueue = overrides.prs ?? [{ number: 9, url: 'https://x/pr/9' }]
  const ghCalls: string[][] = []
  const github = {
    listAutopilotIssues: async (_repo: string, _user: string) => {
      ghCalls.push(['issues'])
      const issues = overrides.issues ?? [{ number: 42, title: 'Faire X' }]
      return typeof issues === 'function' ? issues() : issues
    },
    prForBranch: async (_repo: string, branch: string, _user: string) => {
      ghCalls.push(['pr', branch])
      return prQueue.length > 0 ? (prQueue.shift() ?? null) : null
    },
    issueBody: async (_repo: string, issue: number, _user: string) => `corps de #${issue}`,
  }

  const workspaceCalls: { repoRoot: string; op: string; issue: number }[] = []
  const workspace = (repoRoot: string): Workspace => ({
    prepare: async (issue: number) => {
      workspaceCalls.push({ repoRoot, op: 'prepare', issue })
      if (overrides.prepareError !== undefined) throw new Error(overrides.prepareError)
      return { path: `${repoRoot}/.worktrees/autopilot-${issue}`, branch: `autopilot/${issue}` }
    },
    cleanup: async (issue: number) => {
      workspaceCalls.push({ repoRoot, op: 'cleanup', issue })
    },
  })

  const runner = new AutopilotRunner({
    data,
    sessions: sessions as never,
    streams: streams as never,
    github: github as never,
    workspace,
    itemTimeoutMs: 200,
  })

  const start = () => runner.start({ projectId: 'p1', repo: 'o/r', githubUser: 'u', maxItems: 3 })

  return { data, runner, start, emit, messages, published, permissionCalls, ghCalls, workspaceCalls }
}

describe('AutopilotRunner', () => {
  test('run nominal : issue → worktree → projet temporaire → session bypass → PR → pr_opened', async () => {
    const d = makeDeps()
    d.start()
    await tick()

    // item running, session draft créée dans un projet temporaire pointant sur le worktree
    let item = d.data.get().autopilot.items[0]!
    expect(item.status).toBe('running')
    expect(item.branch).toBe('autopilot/42')
    expect(item.repoRoot).toBe('/repo')
    const project = d.data.get().projects.find((p) => p.id === item.projectId)
    expect(project?.path).toBe('/repo/.worktrees/autopilot-42')
    expect(d.permissionCalls).toContainEqual({ id: 'draft-1', mode: 'bypassPermissions' })
    // le prompt part avec le corps de l'issue
    expect(d.messages).toHaveLength(1)
    expect(d.messages[0]!.raw).toContain('corps de #42')

    // fin de tour → PR trouvée → pr_opened, run terminé
    d.emit('draft-1', 'idle')
    await tick()
    item = d.data.get().autopilot.items[0]!
    expect(item.status).toBe('pr_opened')
    expect(item.prUrl).toBe('https://x/pr/9')
    expect(item.endedAt).toBeDefined()
    expect(d.data.get().autopilot.run).toBeNull()
    // le hub a été notifié
    expect(d.published.some((e) => e.type === 'autopilot_status')).toBe(true)
  })

  test('remap draft→SDK : la transition arrive sous l’id SDK et item.sessionId est mis à jour', async () => {
    const d = makeDeps()
    d.start()
    await tick()
    // matérialisation : draft-1 → sdk-1
    d.data.mapDraft('draft-1', 'sdk-1')
    d.emit('sdk-1', 'idle')
    await tick()
    const item = d.data.get().autopilot.items[0]!
    expect(item.status).toBe('pr_opened')
    expect(item.sessionId).toBe('sdk-1')
  })

  test('pas de PR au premier idle → une relance, puis pr_opened au second', async () => {
    const d = makeDeps({ prs: [null, { number: 5, url: 'https://x/pr/5' }] })
    d.start()
    await tick()
    d.emit('draft-1', 'idle')
    await tick()
    // relance envoyée
    expect(d.messages).toHaveLength(2)
    expect(d.messages[1]!.raw).toContain('gates')
    d.emit('draft-1', 'idle')
    await tick()
    expect(d.data.get().autopilot.items[0]!.status).toBe('pr_opened')
  })

  test('pas de PR après la relance → failed, une SEULE relance', async () => {
    const d = makeDeps({ prs: [null, null] })
    d.start()
    await tick()
    d.emit('draft-1', 'idle')
    await tick()
    d.emit('draft-1', 'idle')
    await tick()
    const item = d.data.get().autopilot.items[0]!
    expect(item.status).toBe('failed')
    expect(item.error).toContain('PR')
    expect(d.messages).toHaveLength(2)
    expect(d.data.get().autopilot.run).toBeNull()
  })

  test('transition error → failed immédiat, le run continue avec l’item suivant', async () => {
    const d = makeDeps({ issues: [{ number: 1, title: 'A' }, { number: 2, title: 'B' }], prs: [{ number: 3, url: 'https://x/3' }] })
    d.start()
    await tick()
    d.emit('draft-1', 'error')
    await tick()
    expect(d.data.get().autopilot.items[0]!.status).toBe('failed')
    // item 2 démarre
    expect(d.data.get().autopilot.items[1]!.status).toBe('running')
    d.emit('draft-2', 'idle')
    await tick()
    expect(d.data.get().autopilot.items[1]!.status).toBe('pr_opened')
  })

  test('error avec rate limit rejeté encore valide → arrêt du run entier', async () => {
    const d = makeDeps({ issues: [{ number: 1, title: 'A' }, { number: 2, title: 'B' }] })
    d.data.recordRateLimit({ window: 'five_hour', utilization: 100, status: 'rejected', resetsAt: new Date(Date.now() + 3600_000).toISOString(), recordedAt: new Date().toISOString() })
    d.start()
    await tick()
    d.emit('draft-1', 'error')
    await tick()
    expect(d.data.get().autopilot.items[0]!.status).toBe('failed')
    expect(d.data.get().autopilot.items[1]!.status).toBe('queued')
    expect(d.data.get().autopilot.run).toBeNull()
  })

  test('un rate limit rejeté PÉRIMÉ n’arrête pas le run', async () => {
    const d = makeDeps({ issues: [{ number: 1, title: 'A' }, { number: 2, title: 'B' }], prs: [null, null, null, null] })
    d.data.recordRateLimit({ window: 'five_hour', utilization: 100, status: 'rejected', resetsAt: new Date(Date.now() - 3600_000).toISOString(), recordedAt: new Date().toISOString() })
    d.start()
    await tick()
    d.emit('draft-1', 'error')
    await tick()
    // le run continue : item 2 running
    expect(d.data.get().autopilot.items[1]!.status).toBe('running')
  })

  test('stop() : l’item courant va au bout, pas de relance, les queued ne démarrent pas', async () => {
    const d = makeDeps({ issues: [{ number: 1, title: 'A' }, { number: 2, title: 'B' }], prs: [null] })
    d.start()
    await tick()
    d.runner.stop()
    expect(d.data.get().autopilot.run?.state).toBe('stopping')
    d.emit('draft-1', 'idle')
    await tick()
    const items = d.data.get().autopilot.items
    // pas de relance malgré l'absence de PR → failed direct
    expect(d.messages).toHaveLength(1)
    expect(items[0]!.status).toBe('failed')
    expect(items[1]!.status).toBe('queued')
    expect(d.data.get().autopilot.run).toBeNull()
  })

  test('timeout → abort envoyé, item failed ; l’idle tardif ne re-traite pas l’item', async () => {
    const d = makeDeps({ prs: [] })
    d.start()
    await tick()
    await new Promise((r) => setTimeout(r, 350))
    const item = d.data.get().autopilot.items[0]!
    expect(item.status).toBe('failed')
    expect(item.error).toContain('timeout')
    expect(d.messages.some((m) => m.raw.includes('"abort"'))).toBe(true)
    const ghBefore = d.ghCalls.length
    d.emit('draft-1', 'idle') // settle post-abort — ne doit rien déclencher
    await tick()
    expect(d.ghCalls.length).toBe(ghBefore)
  })

  test('start pendant un run → AutopilotConflictError', async () => {
    const d = makeDeps()
    d.start()
    await tick()
    expect(() => d.start()).toThrow(AutopilotConflictError)
  })

  test('fetch des issues qui lève → run null + lastError (jamais bloqué en running)', async () => {
    const d = makeDeps({ issues: () => Promise.reject(new Error('gh a échoué pour o/r : réseau')) })
    d.start()
    await tick()
    expect(d.data.get().autopilot.run).toBeNull()
    expect(d.data.get().autopilot.lastError).toContain('réseau')
  })

  test('0 issue → run null + lastError explicite', async () => {
    const d = makeDeps({ issues: [] })
    d.start()
    await tick()
    expect(d.data.get().autopilot.run).toBeNull()
    expect(d.data.get().autopilot.lastError).toContain('aucune issue')
  })

  test('échec du prepare (worktree) → item failed FR, le run continue', async () => {
    const d = makeDeps({ issues: [{ number: 1, title: 'A' }, { number: 2, title: 'B' }], prepareError: 'création du worktree impossible : sale' })
    d.start()
    await tick()
    const items = d.data.get().autopilot.items
    expect(items[0]!.status).toBe('failed')
    expect(items[0]!.error).toContain('worktree')
    expect(items[1]!.status).toBe('failed')
    expect(d.data.get().autopilot.run).toBeNull()
  })

  test('cleanup : items terminaux nettoyés depuis leur repoRoot, projets temporaires retirés, non-terminaux conservés', async () => {
    const d = makeDeps()
    d.start()
    await tick()
    d.emit('draft-1', 'idle')
    await tick()
    const before = d.data.get().autopilot.items[0]!
    expect(before.status).toBe('pr_opened')
    const tempProjectId = before.projectId

    await d.runner.cleanup()
    expect(d.workspaceCalls).toContainEqual({ repoRoot: '/repo', op: 'cleanup', issue: 42 })
    expect(d.data.get().autopilot.items).toHaveLength(0)
    expect(d.data.get().projects.some((p) => p.id === tempProjectId)).toBe(false)
    // le projet cible n'est PAS touché
    expect(d.data.get().projects.some((p) => p.id === 'p1')).toBe(true)
  })
})
