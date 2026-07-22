import { join, resolve, sep } from 'node:path'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import type { ServerEvent } from '@atelier/shared'
import type { AppData } from './store/app-data'
import type { SdkClient } from './sdk/sdk-client'
import type { SessionsService } from './sessions/sessions-service'
import { sessionsRoutes } from './sessions/sessions-routes'
import { settingsRoutes } from './routes/settings-routes'
import type { SessionStreamRegistry } from './stream/session-stream'

// Security model: same-origin serving + loopback binding + token auth.
// No CORS headers needed — the server only listens on 127.0.0.1 and the web
// client is served from the same origin. The token covers WS upgrades too via
// the ?token= query param (browsers cannot set headers on WS handshakes).

export function createApp({ data, sessions, sdk, streams, token, webDist, versionFile }: { data: AppData; sessions: SessionsService; sdk: SdkClient; streams: SessionStreamRegistry; token: string; webDist?: string; versionFile?: string }): Hono {
  const app = new Hono()

  // Token middleware scoped to /api/* so that /health and static assets stay open
  app.use('/api/*', async (c, next) => {
    const authHeader = c.req.header('Authorization')
    const queryToken = c.req.query('token')

    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    const provided = bearer ?? queryToken ?? null

    if (provided !== token) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  })

  const api = new Hono()
  api.route('/', sessionsRoutes(data, sessions))
  api.route('/', settingsRoutes(data, sessions))

  // Update detection: read version.json from DISK on every request — the
  // server process was loaded at app launch, but the repo may have moved on
  // (repo-tethered bundle). The web client compares with its build-time
  // version and toasts « Une nouvelle version est disponible ».
  if (versionFile !== undefined) {
    api.get('/version', async (c) => {
      try {
        const parsed = JSON.parse(await Bun.file(versionFile).text()) as { version?: unknown; notes?: unknown }
        if (typeof parsed.version !== 'string' || !Array.isArray(parsed.notes)) throw new Error('shape')
        return c.json({ version: parsed.version, notes: parsed.notes.filter((note): note is string => typeof note === 'string') })
      } catch {
        return c.json({ error: 'version.json illisible' }, 500)
      }
    })
  }

  // WS glue only — all behavior lives in SessionStream (tested socket-free).
  api.get(
    '/sessions/:id/stream',
    // Guard BEFORE the upgrade: the registry caches one stream per session
    // forever, so a first connect with a missing/unknown projectId would poison
    // the singleton — later connects with the correct projectId would silently
    // attach to a stream whose every user_message fails until restart.
    async (c, next) => {
      const projectId = c.req.query('projectId')
      if (!projectId || !data.get().projects.some((p) => p.id === projectId)) {
        return c.json({ error: `unknown projectId: ${projectId ?? ''}` }, 400)
      }
      await next()
    },
    upgradeWebSocket((c) => {
      // upgradeWebSocket's context is not path-typed — param() comes back
      // optional; projectId was validated (present + known) by the guard above.
      const stream = streams.get(c.req.param('id') ?? '', c.req.query('projectId') as string)
      let sink: ((event: ServerEvent) => void) | null = null
      return {
        onOpen(_evt, ws) {
          sink = (event) => ws.send(JSON.stringify(event))
          stream.onConnect(sink)
        },
        onMessage(evt) {
          if (typeof evt.data === 'string') stream.onMessage(evt.data)
        },
        onClose() {
          if (sink) stream.onClose(sink)
        },
      }
    })
  )

  app.route('/api', api)

  app.get('/health', (c) => c.json({ ok: true }))

  // Packaged mode: serve the built web app (--web-dist). Registered LAST so
  // /api/* and /health keep precedence. Kept manual (Bun.file) on purpose —
  // decode once, deny any '..' segment, and double-check the resolved path
  // stays under the dist root before touching the filesystem.
  if (webDist) {
    const root = resolve(webDist)
    app.get('*', async (c) => {
      let pathname: string
      try {
        pathname = decodeURIComponent(new URL(c.req.url).pathname)
      } catch {
        return c.text('Bad Request', 400)
      }
      if (pathname.includes('..') || pathname.includes('\0')) {
        return c.text('Forbidden', 403)
      }
      const filePath = resolve(join(root, pathname === '/' ? 'index.html' : pathname))
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        return c.text('Forbidden', 403)
      }
      const file = Bun.file(filePath)
      if (!(await file.exists())) return c.notFound()
      // Bun.file infers the MIME type from the extension. Serve the bytes with
      // an explicit Content-Type (a BunFile body would rely on Response
      // internals to derive both, which the test-side DOM polyfill breaks) —
      // SPA assets are small, buffering them is fine for a local app.
      return new Response(await file.arrayBuffer(), { headers: { 'Content-Type': file.type } })
    })
  }

  return app
}
