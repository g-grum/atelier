import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from '../store/app-data'
import type { GitRun } from '../github/git-remote'
import { AutopilotConflictError } from './autopilot-runner'
import { autopilotRoutes } from './autopilot-routes'

function freshData() {
  const data = new AppData(join(mkdtempSync(join(tmpdir(), 'atelier-ap-routes-')), 'data.json'))
  data.update((d) => {
    d.projects.push({ id: 'p1', path: '/work/atelier', color: 'cyan' })
  })
  return data
}

const originOk: GitRun = async () => ({ stdout: 'git@github.com-g-grum:g-grum/atelier.git\n', stderr: '', exitCode: 0 })
const originNone: GitRun = async () => ({ stdout: '', stderr: 'error: No such remote', exitCode: 2 })

function fakeRunner() {
  const calls: unknown[] = []
  return {
    calls,
    start: (params: unknown) => {
      calls.push(['start', params])
    },
    stop: () => {
      calls.push(['stop'])
    },
    cleanup: async () => {
      calls.push(['cleanup'])
    },
  }
}

describe('autopilot routes', () => {
  test('GET /autopilot renvoie l’état persisté', async () => {
    const data = freshData()
    const app = autopilotRoutes(fakeRunner() as never, data, originOk)
    const res = await app.request('/autopilot')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ run: null, items: [] })
  })

  test('POST /autopilot/start → 202 et transmet repo/user/maxItems au runner', async () => {
    const data = freshData()
    const runner = fakeRunner()
    const app = autopilotRoutes(runner as never, data, originOk)
    const res = await app.request('/autopilot/start', { method: 'POST', body: JSON.stringify({ projectId: 'p1', maxItems: 2 }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(202)
    expect(runner.calls).toEqual([['start', { projectId: 'p1', repo: 'g-grum/atelier', githubUser: 'alice-dev', maxItems: 2 }]])
  })

  test('maxItems par défaut = 3, borné à 1-10', async () => {
    const data = freshData()
    const runner = fakeRunner()
    const app = autopilotRoutes(runner as never, data, originOk)
    await app.request('/autopilot/start', { method: 'POST', body: JSON.stringify({ projectId: 'p1' }), headers: { 'content-type': 'application/json' } })
    expect(runner.calls[0]).toEqual(['start', expect.objectContaining({ maxItems: 3 })])
    const res = await app.request('/autopilot/start', { method: 'POST', body: JSON.stringify({ projectId: 'p1', maxItems: 99 }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(400)
  })

  test('projet introuvable → 404', async () => {
    const app = autopilotRoutes(fakeRunner() as never, freshData(), originOk)
    const res = await app.request('/autopilot/start', { method: 'POST', body: JSON.stringify({ projectId: 'nope' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(404)
  })

  test('projet sans remote GitHub → 400 FR', async () => {
    const app = autopilotRoutes(fakeRunner() as never, freshData(), originNone)
    const res = await app.request('/autopilot/start', { method: 'POST', body: JSON.stringify({ projectId: 'p1' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toContain('remote GitHub')
  })

  test('run déjà en cours → 409', async () => {
    const runner = fakeRunner()
    runner.start = () => {
      throw new AutopilotConflictError()
    }
    const app = autopilotRoutes(runner as never, freshData(), originOk)
    const res = await app.request('/autopilot/start', { method: 'POST', body: JSON.stringify({ projectId: 'p1' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(409)
  })

  test('POST /autopilot/stop → 202 (idempotent)', async () => {
    const runner = fakeRunner()
    const app = autopilotRoutes(runner as never, freshData(), originOk)
    const res = await app.request('/autopilot/stop', { method: 'POST' })
    expect(res.status).toBe(202)
    expect(runner.calls).toEqual([['stop']])
  })

  test('POST /autopilot/cleanup → 200', async () => {
    const runner = fakeRunner()
    const app = autopilotRoutes(runner as never, freshData(), originOk)
    const res = await app.request('/autopilot/cleanup', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(runner.calls).toEqual([['cleanup']])
  })
})
