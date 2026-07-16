import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from './store/app-data'
import { MockSdkClient } from './sdk/sdk-client.mock'
import { SessionsService } from './sessions/sessions-service'
import { createApp } from './app'

function freshApp(webDist?: string) {
  const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-app-')), 'data.json')
  const data = new AppData(filePath)
  const sdk = new MockSdkClient()
  const sessions = new SessionsService(sdk, data)
  const app = createApp({ data, sessions, sdk, token: 'test-token', webDist })
  return { app, data, sessions }
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
