import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import type { ServerEvent } from '@atelier/shared'
import type { AppData } from './store/app-data'
import type { SdkClient } from './sdk/sdk-client'
import type { SessionsService } from './sessions/sessions-service'
import { sessionsRoutes } from './sessions/sessions-routes'
import { settingsRoutes } from './routes/settings-routes'
import { SessionStreamRegistry } from './stream/session-stream'

// Security model: same-origin serving + loopback binding + token auth.
// No CORS headers needed — the server only listens on 127.0.0.1 and the web
// client is served from the same origin. The token covers WS upgrades too via
// the ?token= query param (browsers cannot set headers on WS handshakes).

export function createApp({ data, sessions, sdk, token }: { data: AppData; sessions: SessionsService; sdk: SdkClient; token: string }): Hono {
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
  api.route('/', settingsRoutes(data))

  // WS glue only — all behavior lives in SessionStream (tested socket-free).
  const streams = new SessionStreamRegistry(data, sdk)
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

  return app
}
