import { describe, expect, test } from 'bun:test'
import type { WidgetInstance } from '@atelier/shared'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from './store/app-data'
import { MockSdkClient } from './sdk/sdk-client.mock'
import { SessionsService } from './sessions/sessions-service'
import { SessionStreamRegistry } from './stream/session-stream'
import { GithubService } from './github/github-service'
import { createApp } from './app'

// No-op fake: an unreachable `gh` (exitCode: 1 on every call) — pre-existing
// tests never touch GitHub, so this just needs to exist and never be hit.
function noopGithubService(): GithubService {
  return new GithubService(async () => ({ stdout: '', stderr: 'unused in this test', exitCode: 1 }))
}

function freshApp(webDist?: string, sdk: MockSdkClient = new MockSdkClient(), versionFile?: string, github: GithubService = noopGithubService()) {
  const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-app-')), 'data.json')
  const data = new AppData(filePath)
  const streams = new SessionStreamRegistry(data, sdk)
  const sessions = new SessionsService(sdk, data, streams)
  const app = createApp({ data, sessions, sdk, streams, token: 'test-token', webDist, versionFile, github })
  return { app, data, sessions, filePath }
}

// A fake built web app: dist/ lives INSIDE a parent dir that also holds a
// secret file, so traversal tests can prove '..' never escapes the dist root.
function makeWebDist() {
  const parent = mkdtempSync(join(tmpdir(), 'atelier-webdist-'))
  const dist = join(parent, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>atelier-test-index</title>')
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log("atelier-test-asset")')
  writeFileSync(join(parent, 'secret.txt'), 'top-secret')
  return dist
}

describe('createApp', () => {
  // 1. Auth middleware
  test('401 without token on /api/projects', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/projects')
    expect(res.status).toBe(401)
  })

  test('200 with Authorization: Bearer token on /api/projects', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/projects', {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).toBe(200)
  })

  test('200 with ?token= query param on /api/projects', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/projects?token=test-token')
    expect(res.status).toBe(200)
  })

  // 2. POST /api/projects color cycling + GET list
  test('POST /api/projects assigns colors by cycling the palette — amber excluded (reserved for permission prompts)', async () => {
    const { app } = freshApp()
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    // Six creates cover the full palette plus the wrap-around. The design
    // system reserves amber EXCLUSIVELY for permission prompts (spec) — a
    // project identity must never claim it.
    const expected = ['cyan', 'magenta', 'violet', 'mint', 'teal', 'cyan']
    for (const [index, color] of expected.entries()) {
      const res = await app.request('/api/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: `/tmp/p${index}` }),
      })
      expect(res.status).toBe(201)
      const project = await res.json() as { color: string }
      expect(project.color).toBe(color)
    }
  })

  test('GET /api/projects returns created projects', async () => {
    const { app } = freshApp()
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    await app.request('/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: '/tmp/x' }),
    })

    const res = await app.request('/api/projects', { headers })
    const projects = await res.json() as unknown[]
    expect(projects).toHaveLength(1)
  })

  // 2b. Per-project session counts (v0.2): GET/POST /api/projects return the
  // ProjectSummary DTO — the persisted Project stays count-free, the routes
  // enrich through SessionsService.countSessions at response time.
  test('GET /api/projects enriches every project with its sessionCount (SDK sessions + drafts, per path)', async () => {
    const populated = [
      { id: 's1', name: 'one', updatedAt: '2026-07-01T00:00:00.000Z', messageCount: 2 },
      { id: 's2', name: 'two', updatedAt: '2026-07-02T00:00:00.000Z', messageCount: 4 },
    ]
    const sdk = new MockSdkClient()
    // Per-path scripting: only /tmp/populated has Claude Code history.
    sdk.listSessions = async (cwd) => (cwd === '/tmp/populated' ? populated : [])
    const { app } = freshApp(undefined, sdk)
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const bodies: { id: string; path: string }[] = []
    for (const path of ['/tmp/populated', '/tmp/fresh']) {
      const res = await app.request('/api/projects', { method: 'POST', headers: auth, body: JSON.stringify({ path }) })
      bodies.push(await res.json() as { id: string; path: string })
    }
    // A draft on the fresh project must count too (unsent drafts are sessions to the user).
    await app.request(`/api/projects/${bodies[1]?.id}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'brouillon' }),
    })

    const res = await app.request('/api/projects', { headers: auth })
    expect(res.status).toBe(200)
    const projects = await res.json() as { path: string; sessionCount: number }[]
    expect(projects).toHaveLength(2)
    expect(projects.find((p) => p.path === '/tmp/populated')?.sessionCount).toBe(2)
    expect(projects.find((p) => p.path === '/tmp/fresh')?.sessionCount).toBe(1)
  })

  test('POST /api/projects responds with the enriched ProjectSummary — count of an already-populated folder, else 0', async () => {
    const populated = [
      { id: 's1', name: 'one', updatedAt: '2026-07-01T00:00:00.000Z', messageCount: 2 },
      { id: 's2', name: 'two', updatedAt: '2026-07-02T00:00:00.000Z', messageCount: 4 },
    ]
    const sdk = new MockSdkClient()
    sdk.listSessions = async (cwd) => (cwd === '/tmp/populated' ? populated : [])
    const { app } = freshApp(undefined, sdk)
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const rPopulated = await app.request('/api/projects', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: '/tmp/populated' }),
    })
    expect(rPopulated.status).toBe(201)
    const populatedProject = await rPopulated.json() as { id: string; path: string; color: string; sessionCount: number }
    expect(populatedProject.sessionCount).toBe(2)
    expect(populatedProject.path).toBe('/tmp/populated')

    const rFresh = await app.request('/api/projects', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: '/tmp/fresh' }),
    })
    expect(rFresh.status).toBe(201)
    const freshProject = await rFresh.json() as { sessionCount: number }
    expect(freshProject.sessionCount).toBe(0)
  })

  // 3. POST /api/projects/:id/sessions + GET /api/projects/:id/sessions
  test('POST /api/projects/:id/sessions creates a draft and GET lists it first', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const rp = await app.request('/api/projects', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: '/tmp/x' }),
    })
    const project = await rp.json() as { id: string }

    const rs = await app.request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'brouillon' }),
    })
    expect(rs.status).toBe(201)
    const draft = await rs.json() as { isDraft: boolean; name: string }
    expect(draft.isDraft).toBe(true)
    expect(draft.name).toBe('brouillon')

    const rl = await app.request(`/api/projects/${project.id}/sessions`, { headers: auth })
    const list = await rl.json() as { isDraft: boolean }[]
    expect(list.length).toBeGreaterThan(0)
    expect(list[0]?.isDraft).toBe(true)
  })

  // 4. PATCH /api/sessions/:id rename
  test('PATCH /api/sessions/:id renames a draft', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const rp = await app.request('/api/projects', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: '/tmp/x' }),
    })
    const project = await rp.json() as { id: string }

    const rs = await app.request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'original' }),
    })
    const draft = await rs.json() as { id: string }

    const rr = await app.request(`/api/sessions/${draft.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ name: 'renamed' }),
    })
    expect(rr.status).toBe(200)

    const rl = await app.request(`/api/projects/${project.id}/sessions`, { headers: auth })
    const list = await rl.json() as { name: string }[]
    expect(list[0]?.name).toBe('renamed')
  })

  // 4bis. PATCH /api/sessions/:id permissionMode
  test('PATCH /api/sessions/:id records the permission mode; invalid values are 400', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const rp = await app.request('/api/projects', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: '/tmp/x' }),
    })
    const project = await rp.json() as { id: string }

    const rs = await app.request(`/api/projects/${project.id}/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({}) })
    const draft = await rs.json() as { id: string; permissionMode: string | null }
    expect(draft.permissionMode).toBeNull()

    const bad = await app.request(`/api/sessions/${draft.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ permissionMode: 'yolo' }),
    })
    expect(bad.status).toBe(400)

    const ok = await app.request(`/api/sessions/${draft.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ permissionMode: 'bypassPermissions' }),
    })
    expect(ok.status).toBe(200)

    const rl = await app.request(`/api/projects/${project.id}/sessions`, { headers: auth })
    const list = await rl.json() as { permissionMode: string | null }[]
    expect(list[0]?.permissionMode).toBe('bypassPermissions')
  })

  // 4bis-b. GET /api/usage/limits — plan gauges snapshot
  test('GET /api/usage/limits returns the last-known snapshot per window', async () => {
    const { app, data } = freshApp()
    const auth = { Authorization: 'Bearer test-token' }

    const empty = await app.request('/api/usage/limits', { headers: auth })
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual([])

    data.recordRateLimit({ window: 'five_hour', utilization: 34, status: 'allowed', resetsAt: '2026-07-17T16:00:00.000Z', recordedAt: '2026-07-17T12:00:00.000Z' })
    data.recordRateLimit({ window: 'seven_day', utilization: 61, status: 'allowed_warning', recordedAt: '2026-07-17T12:00:00.000Z' })

    const res = await app.request('/api/usage/limits', { headers: auth })
    const limits = await res.json() as { window: string; utilization: number }[]
    expect(limits).toHaveLength(2)
    expect(limits.find((l) => l.window === 'five_hour')?.utilization).toBe(34)
    expect(limits.find((l) => l.window === 'seven_day')?.utilization).toBe(61)
  })

  // 4ter. GET /api/version — update detection
  test('GET /api/version reads version.json from DISK at request time — a repo update while running is visible', async () => {
    const versionFile = join(mkdtempSync(join(tmpdir(), 'atelier-version-')), 'version.json')
    writeFileSync(versionFile, JSON.stringify({ version: '0.1.1', notes: ['note un'] }))
    const { app } = freshApp(undefined, undefined, versionFile)
    const auth = { Authorization: 'Bearer test-token' }

    const r1 = await app.request('/api/version', { headers: auth })
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ version: '0.1.1', notes: ['note un'] })

    // The repo moves on while the server keeps running — the route must see it.
    writeFileSync(versionFile, JSON.stringify({ version: '0.2.0', notes: ['note deux', 'note trois'] }))
    const r2 = await app.request('/api/version', { headers: auth })
    expect(await r2.json()).toEqual({ version: '0.2.0', notes: ['note deux', 'note trois'] })
  })

  test('GET /api/version with an unreadable file is a 500, never a crash', async () => {
    const { app } = freshApp(undefined, undefined, '/no/such/version.json')
    const res = await app.request('/api/version', { headers: { Authorization: 'Bearer test-token' } })
    expect(res.status).toBe(500)
  })

  // 5. DELETE /api/sessions/:id
  test('DELETE /api/sessions/:id removes the draft from the list', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const rp = await app.request('/api/projects', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: '/tmp/x' }),
    })
    const project = await rp.json() as { id: string }

    const rs = await app.request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'to delete' }),
    })
    const draft = await rs.json() as { id: string }

    const rd = await app.request(`/api/sessions/${draft.id}`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(rd.status).toBe(204)

    const rl = await app.request(`/api/projects/${project.id}/sessions`, { headers: auth })
    const list = await rl.json() as { id: string }[]
    expect(list.every((s) => s.id !== draft.id)).toBe(true)
  })

  test('DELETE /api/sessions/:id deletes a real session through the SDK and returns 204', async () => {
    const sdk = new MockSdkClient({ sessions: [{ id: 's1', name: 'x', updatedAt: '2026-07-01T00:00:00.000Z', messageCount: 1 }] })
    const { app } = freshApp(undefined, sdk)
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
    await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify({ path: '/tmp/x' }) })

    const res = await app.request('/api/sessions/s1', { method: 'DELETE', headers })

    expect(res.status).toBe(204)
    expect(sdk.calls).toContainEqual({ method: 'deleteSession', args: ['s1', '/tmp/x'] })
  })

  // Regression: this used to be a silent no-op that still answered 204.
  test('DELETE /api/sessions/:id with an unknown id returns 404', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/sessions/ghost', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).toBe(404)
  })

  // 6. GET /api/sessions/:id/messages on draft → []
  test('GET /api/sessions/:id/messages on a draft returns []', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const rp = await app.request('/api/projects', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: '/tmp/x' }),
    })
    const project = await rp.json() as { id: string }

    const rs = await app.request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'msg test' }),
    })
    const draft = await rs.json() as { id: string }

    const rm = await app.request(`/api/sessions/${draft.id}/messages`, { headers: auth })
    expect(rm.status).toBe(200)
    expect(await rm.json()).toEqual([])
  })

  // 7. DELETE /api/projects/:id unregisters project
  test('DELETE /api/projects/:id removes the project from the list', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const rp = await app.request('/api/projects', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: '/tmp/x' }),
    })
    const project = await rp.json() as { id: string }

    const rd = await app.request(`/api/projects/${project.id}`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(rd.status).toBe(204)

    const rl = await app.request('/api/projects', { headers: auth })
    const list = await rl.json() as { id: string }[]
    expect(list.every((p) => p.id !== project.id)).toBe(true)
  })

  // 8. GET/PATCH /api/preferences
  test('GET /api/preferences returns defaults', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/preferences', {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).toBe(200)
    const prefs = await res.json() as { ide: string; defaultModel: string; windowBudgetTokens: number; weeklyBudgetTokens: number }
    expect(prefs.ide).toBe('webstorm')
    expect(prefs.defaultModel).toBe('claude-fable-5')
    expect(prefs.windowBudgetTokens).toBe(2_000_000)
    expect(prefs.weeklyBudgetTokens).toBe(12_000_000)
  })

  test('GET /api/preferences exposes defaultPermissionMode null by default — the gate asks each session', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/preferences', {
      headers: { Authorization: 'Bearer test-token' },
    })
    const prefs = await res.json() as { defaultPermissionMode: 'default' | 'bypassPermissions' | null }
    expect(prefs.defaultPermissionMode).toBeNull()
  })

  test('PATCH /api/preferences persists defaultPermissionMode and survives a reload', async () => {
    const { app, filePath } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const rp = await app.request('/api/preferences', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ defaultPermissionMode: 'bypassPermissions' }),
    })
    expect(rp.status).toBe(200)
    const prefs = await rp.json() as { defaultPermissionMode: string | null }
    expect(prefs.defaultPermissionMode).toBe('bypassPermissions')

    const reloaded = new AppData(filePath)
    expect(reloaded.get().preferences.defaultPermissionMode).toBe('bypassPermissions')
  })

  test('PATCH /api/preferences with defaultPermissionMode null CLEARS a set value (undefined-vs-null trap)', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    await app.request('/api/preferences', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ defaultPermissionMode: 'default' }),
    })
    // Assertion intermédiaire : sans elle, le test passerait PAR VACUITÉ avant
    // l'implémentation (deux PATCH ignorés → la valeur reste null → toBeNull vert).
    const rg1 = await app.request('/api/preferences', { headers: auth })
    expect(((await rg1.json()) as { defaultPermissionMode: string | null }).defaultPermissionMode).toBe('default')

    const rp = await app.request('/api/preferences', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ defaultPermissionMode: null }),
    })
    expect(rp.status).toBe(200)
    const prefs = await rp.json() as { defaultPermissionMode: string | null }
    expect(prefs.defaultPermissionMode).toBeNull()
  })

  test('PATCH /api/preferences rejects an unknown defaultPermissionMode with 400 and leaves preferences untouched', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    for (const value of ['yolo', 42, true, {}] as const) {
      const res = await app.request('/api/preferences', {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ defaultPermissionMode: value }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(typeof body.error).toBe('string')
    }
    const rg = await app.request('/api/preferences', { headers: auth })
    const prefs = await rg.json() as { defaultPermissionMode: string | null }
    expect(prefs.defaultPermissionMode).toBeNull()
  })

  test('PATCH /api/preferences persists changes', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const rp = await app.request('/api/preferences', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ ide: 'vscode' }),
    })
    expect(rp.status).toBe(200)

    const rg = await app.request('/api/preferences', { headers: auth })
    const prefs = await rg.json() as { ide: string }
    expect(prefs.ide).toBe('vscode')
  })

  // 8a. Calibratable budgets (v0.2): PATCH accepts the two optional integer
  // budget fields; the gauges are honest ESTIMATES, so the user can calibrate.
  test('PATCH /api/preferences accepts a budget calibration that survives a reload', async () => {
    const { app, filePath } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const rp = await app.request('/api/preferences', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ windowBudgetTokens: 3_000_000 }),
    })
    expect(rp.status).toBe(200)
    const prefs = await rp.json() as { windowBudgetTokens: number; weeklyBudgetTokens: number }
    expect(prefs.windowBudgetTokens).toBe(3_000_000)
    expect(prefs.weeklyBudgetTokens).toBe(12_000_000)

    // Reload: a fresh store on the same data file still carries the calibration.
    const reloaded = new AppData(filePath)
    expect(reloaded.get().preferences.windowBudgetTokens).toBe(3_000_000)
  })

  test('PATCH /api/preferences rejects invalid budgets with 400 JSON and leaves preferences untouched — never a 500', async () => {
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
    const invalid: [field: string, value: unknown][] = [
      ['windowBudgetTokens', 'x'],
      ['windowBudgetTokens', -1],
      ['windowBudgetTokens', 0],
      ['windowBudgetTokens', 1.5],
      ['weeklyBudgetTokens', 'x'],
      ['weeklyBudgetTokens', 0],
    ]
    for (const [field, value] of invalid) {
      const { app } = freshApp()
      const res = await app.request('/api/preferences', {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ [field]: value }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(typeof body.error).toBe('string')

      const rg = await app.request('/api/preferences', { headers: auth })
      const prefs = await rg.json() as Record<string, number>
      expect(prefs['windowBudgetTokens']).toBe(2_000_000)
      expect(prefs['weeklyBudgetTokens']).toBe(12_000_000)
    }
  })

  // 8c. GET /api/usage/history — raw events for the web-side estimator.
  test('GET /api/usage/history is token-guarded like every /api route', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/usage/history')
    expect(res.status).toBe(401)
  })

  test('GET /api/usage/history returns the seeded usage events verbatim (4 counters each)', async () => {
    const { app, data } = freshApp()
    const events = [
      { at: '2026-07-16T08:00:00.000Z', inputTokens: 1200, outputTokens: 450, cacheReadTokens: 90_000, cacheCreationTokens: 3_000 },
      { at: '2026-07-16T09:30:00.000Z', inputTokens: 800, outputTokens: 200, cacheReadTokens: 12_000, cacheCreationTokens: 0 },
    ]
    data.update((d) => { d.usageEvents.push(...events) })

    const res = await app.request('/api/usage/history', {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(events)
  })

  // 8b. Body guards: JSON.parse also succeeds on 'null' and '[]' — property
  // access on those killed the handler with a TypeError → 500 (same class as
  // the open-in-ide bug). Any legal JSON body must yield a 4xx JSON error.
  test("POST /api/projects with raw bodies 'null', '[]' and '{}' responds 400 JSON — never a 500", async () => {
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
    for (const raw of ['null', '[]', '{}']) {
      const { app } = freshApp()
      const res = await app.request('/api/projects', { method: 'POST', headers: auth, body: raw })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(typeof body.error).toBe('string')
    }
  })

  test('POST /api/projects with a malformed JSON body responds 400 JSON — never a 500', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: 'not json{',
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(typeof body.error).toBe('string')
  })

  test("PATCH /api/preferences with raw bodies 'null' and '[]' responds 400 JSON and leaves preferences untouched", async () => {
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
    for (const raw of ['null', '[]']) {
      const { app } = freshApp()
      const res = await app.request('/api/preferences', { method: 'PATCH', headers: auth, body: raw })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(typeof body.error).toBe('string')

      const rg = await app.request('/api/preferences', { headers: auth })
      const prefs = await rg.json() as { ide: string }
      expect(prefs.ide).toBe('webstorm')
    }
  })

  test('PATCH /api/preferences with wrong-typed fields (ide: 42) responds 400 instead of corrupting preferences', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
    const res = await app.request('/api/preferences', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ ide: 42 }),
    })
    expect(res.status).toBe(400)

    const rg = await app.request('/api/preferences', { headers: auth })
    const prefs = await rg.json() as { ide: string }
    expect(prefs.ide).toBe('webstorm')
  })

  test('githubUser: defaults to alice-dev, PATCHable, string-validated', async () => {
    const { app } = freshApp()
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
    const before = await (await app.request('/api/preferences', { headers })).json() as { githubUser: string }
    expect(before.githubUser).toBe('alice-dev')
    const patched = await app.request('/api/preferences', { method: 'PATCH', headers, body: JSON.stringify({ githubUser: 'g-grum' }) })
    expect(((await patched.json()) as { githubUser: string }).githubUser).toBe('g-grum')
    const bad = await app.request('/api/preferences', { method: 'PATCH', headers, body: JSON.stringify({ githubUser: 42 }) })
    expect(bad.status).toBe(400)
  })

  test('theme: absent by default, PATCHable to light, rejects invalid value', async () => {
    const { app } = freshApp()
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
    // Clé absente = dark côté client (rétrocompat disque, spec charte v5).
    const before = await (await app.request('/api/preferences', { headers })).json() as Record<string, unknown>
    expect('theme' in before).toBe(false)
    const patched = await app.request('/api/preferences', { method: 'PATCH', headers, body: JSON.stringify({ theme: 'light' }) })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { theme: string }).theme).toBe('light')
    const bad = await app.request('/api/preferences', { method: 'PATCH', headers, body: JSON.stringify({ theme: 'sepia' }) })
    expect(bad.status).toBe(400)
  })

  test("POST /api/projects/:id/sessions with raw bodies 'null' and '[]' responds 400 JSON — never a 500", async () => {
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
    for (const raw of ['null', '[]']) {
      const { app } = freshApp()
      const rp = await app.request('/api/projects', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ path: '/tmp/x' }),
      })
      const project = await rp.json() as { id: string }

      const res = await app.request(`/api/projects/${project.id}/sessions`, { method: 'POST', headers: auth, body: raw })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(typeof body.error).toBe('string')
    }
  })

  test("PATCH /api/sessions/:id with raw bodies 'null' and '[]' responds 400 JSON and leaves the draft untouched", async () => {
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
    for (const raw of ['null', '[]']) {
      const { app } = freshApp()
      const rp = await app.request('/api/projects', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ path: '/tmp/x' }),
      })
      const project = await rp.json() as { id: string }

      const rs = await app.request(`/api/projects/${project.id}/sessions`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'intact' }),
      })
      const draft = await rs.json() as { id: string }

      const res = await app.request(`/api/sessions/${draft.id}`, { method: 'PATCH', headers: auth, body: raw })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(typeof body.error).toBe('string')

      const rl = await app.request(`/api/projects/${project.id}/sessions`, { headers: auth })
      const list = await rl.json() as { name: string }[]
      expect(list[0]?.name).toBe('intact')
    }
  })

  // 9. WS stream route guard: a bad projectId must be rejected BEFORE the
  // upgrade — otherwise the registry caches a permanently broken singleton
  // that even later connects with the CORRECT projectId would attach to.
  test('GET /api/sessions/:id/stream without projectId returns 400', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/sessions/x/stream?token=test-token')
    expect(res.status).toBe(400)
  })

  test('GET /api/sessions/:id/stream with an unknown projectId returns 400', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/sessions/x/stream?token=test-token&projectId=nope')
    expect(res.status).toBe(400)
  })

  test('GET /api/sessions/:id/stream with a known projectId passes the guard', async () => {
    const { app } = freshApp()
    const rp = await app.request('/api/projects', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/x' }),
    })
    const project = await rp.json() as { id: string }

    // No real Bun server here, so the upgrade itself cannot succeed — the guard
    // letting the request through to upgradeWebSocket (anything but 400) is the point.
    const res = await app.request(`/api/sessions/x/stream?token=test-token&projectId=${project.id}`)
    expect(res.status).not.toBe(400)
  })

  // 9bis. Status hub route: receive-only, no projectId guard (unlike the
  // per-session stream above) — any authenticated request reaches the upgrade.
  test('GET /api/sessions-status without a token is rejected by the /api/* auth middleware', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/sessions-status')
    expect(res.status).toBe(401)
  })

  test('GET /api/sessions-status with a valid token passes through to the upgrade', async () => {
    const { app } = freshApp()
    // No real Bun server here, so the upgrade itself cannot succeed — reaching
    // past the auth middleware (anything but 401) is the point.
    const res = await app.request('/api/sessions-status?token=test-token')
    expect(res.status).not.toBe(401)
  })

  // 10. GET/DELETE /api/rules
  test('GET /api/rules returns [] initially', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/rules', {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test('DELETE /api/rules/:id removes the rule', async () => {
    const { app, data } = freshApp()
    const auth = { Authorization: 'Bearer test-token' }

    data.update((d) => {
      d.rules.push({ id: 'r1', projectId: 'p1', toolName: 'Bash', matcher: null })
    })

    const rd = await app.request('/api/rules/r1', {
      method: 'DELETE',
      headers: auth,
    })
    expect(rd.status).toBe(204)

    const rg = await app.request('/api/rules', { headers: auth })
    expect(await rg.json()).toEqual([])
  })

  describe('widgets routes', () => {
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    test('GET /api/widgets returns the default layout on a fresh store', async () => {
      const { app } = freshApp()
      const res = await app.request('/api/widgets', { headers })
      expect(res.status).toBe(200)
      const widgets = (await res.json()) as { type: string }[]
      expect(widgets.map((w) => w.type)).toEqual(['rate-limits', 'modified-files'])
    })

    test('PUT /api/widgets replaces the layout atomically (empty array allowed) and persists', async () => {
      const { app, data } = freshApp()
      const res = await app.request('/api/widgets', { method: 'PUT', headers, body: JSON.stringify([]) })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([])
      expect(data.get().widgets).toEqual([])
    })

    test('PUT /api/widgets rejects an invalid layout with a French 400 and keeps the stored one', async () => {
      const { app, data } = freshApp()
      const before = [...data.get().widgets] // copy — a live reference would make the assertion tautological
      const res = await app.request('/api/widgets', {
        method: 'PUT',
        headers,
        body: JSON.stringify([{ id: 'x', type: 'clock', span: 2, height: 'M' }]),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('type inconnu')
      expect(data.get().widgets).toEqual(before)
    })

    test('PUT /api/widgets survives any legal JSON body (body-guard convention)', async () => {
      const { app } = freshApp()
      for (const body of ['null', '"x"', '42', '{}', '{']) {
        const res = await app.request('/api/widgets', { method: 'PUT', headers, body })
        expect(res.status).toBe(400)
      }
    })

    test('PUT /api/widgets round-trips a non-empty layout, stripping unknown keys', async () => {
      const { app, data } = freshApp()
      const submitted = [{ id: 'w1', type: 'github-prs', span: 1, height: 'S', config: { repo: 'o/r' }, rogue: true }]
      const clean: WidgetInstance[] = [{ id: 'w1', type: 'github-prs', span: 1, height: 'S', config: { repo: 'o/r' } }]
      const res = await app.request('/api/widgets', { method: 'PUT', headers, body: JSON.stringify(submitted) })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(clean)
      expect(data.get().widgets).toEqual(clean)
    })
  })

  // 11. Static serving of the built web app (packaged mode, --web-dist)
  describe('static serving (webDist)', () => {
    test('GET / serves index.html with a text/html content-type', async () => {
      const { app } = freshApp(makeWebDist())
      const res = await app.request('/')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain('atelier-test-index')
    })

    test('GET /assets/* serves the asset with a javascript content-type', async () => {
      const { app } = freshApp(makeWebDist())
      const res = await app.request('/assets/index-abc123.js')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('javascript')
      expect(await res.text()).toContain('atelier-test-asset')
    })

    test('encoded-slash ../ traversal (..%2F) is rejected with 403', async () => {
      const { app } = freshApp(makeWebDist())
      // %2F hides the segment boundary from WHATWG URL normalization; the
      // handler's post-decode '..' check must catch it.
      const res = await app.request('/..%2Fsecret.txt')
      expect(res.status).toBe(403)
      expect(await res.text()).not.toContain('top-secret')
    })

    test('encoded dot-segment traversal (%2e%2e) never escapes the dist root', async () => {
      const { app } = freshApp(makeWebDist())
      // The URL parser normalizes %2e%2e away, so this resolves inside the
      // dist root and 404s — the point is the sibling secret is never served.
      const res = await app.request('/assets/%2e%2e/%2e%2e/secret.txt')
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('top-secret')
    })

    test('missing file under webDist returns 404', async () => {
      const { app } = freshApp(makeWebDist())
      const res = await app.request('/nope.js')
      expect(res.status).toBe(404)
    })

    test('/api/* stays token-guarded when webDist is set', async () => {
      const { app } = freshApp(makeWebDist())
      const res = await app.request('/api/projects')
      expect(res.status).toBe(401)
    })

    test('/health stays reachable when webDist is set', async () => {
      const { app } = freshApp(makeWebDist())
      const res = await app.request('/health')
      expect(res.status).toBe(200)
    })

    test('GET / without webDist stays a 404 (dev mode: Vite serves the SPA)', async () => {
      const { app } = freshApp()
      const res = await app.request('/')
      expect(res.status).toBe(404)
    })
  })
})

describe('github routes', () => {
  const headers = { Authorization: 'Bearer test-token' }
  const service = (responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) =>
    new GithubService(async (args) => {
      const r = responses[args[0] === 'auth' ? 'auth' : 'list'] ?? {}
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 }
    })

  test('GET /api/github/prs returns mapped PRs', async () => {
    const github = service({ auth: { stdout: 't' }, list: { stdout: JSON.stringify([{ number: 1, title: 'T', url: 'u', author: { login: 'a' }, state: 'OPEN', updatedAt: 'now' }]) } })
    const { app } = freshApp(undefined, undefined, undefined, github)
    const res = await app.request('/api/github/prs?repo=o/r', { headers })
    expect(res.status).toBe(200)
    const prs = (await res.json()) as { number: number; state: string }[]
    expect(prs).toEqual([expect.objectContaining({ number: 1, state: 'open' })])
  })

  test('400 on bad repo or bad limit', async () => {
    const { app } = freshApp(undefined, undefined, undefined, service({}))
    expect((await app.request('/api/github/prs?repo=no-slash', { headers })).status).toBe(400)
    expect((await app.request('/api/github/prs?repo=o/r&limit=0', { headers })).status).toBe(400)
    expect((await app.request('/api/github/prs?repo=o/r&limit=abc', { headers })).status).toBe(400)
    expect((await app.request('/api/github/prs?repo=o/r&limit=31', { headers })).status).toBe(400)
  })

  test('502 with the French message on gh failure', async () => {
    const github = service({ auth: { exitCode: 1, stderr: 'nope' } })
    const { app } = freshApp(undefined, undefined, undefined, github)
    const res = await app.request('/api/github/prs?repo=o/r', { headers })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toContain('authentifié')
  })
})
