import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from './store/app-data'
import { MockSdkClient } from './sdk/sdk-client.mock'
import { SessionsService } from './sessions/sessions-service'
import { createApp } from './app'

function freshApp() {
  const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-app-')), 'data.json')
  const data = new AppData(filePath)
  const sdk = new MockSdkClient()
  const sessions = new SessionsService(sdk, data)
  const app = createApp({ data, sessions, sdk, token: 'test-token' })
  return { app, data, sessions }
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
  test('POST /api/projects assigns colors by cycling the palette', async () => {
    const { app } = freshApp()
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const r1 = await app.request('/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: '/tmp/x' }),
    })
    expect(r1.status).toBe(201)
    const p1 = await r1.json() as { color: string }
    expect(p1.color).toBe('cyan')

    const r2 = await app.request('/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: '/tmp/y' }),
    })
    expect(r2.status).toBe(201)
    const p2 = await r2.json() as { color: string }
    expect(p2.color).toBe('magenta')
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
    const prefs = await res.json() as { ide: string; defaultModel: string }
    expect(prefs.ide).toBe('webstorm')
    expect(prefs.defaultModel).toBe('claude-fable-5')
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
})
