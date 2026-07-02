import { Hono } from 'hono'
import type { AppData } from './store/app-data'
import type { SessionsService } from './sessions/sessions-service'
import { sessionsRoutes } from './sessions/sessions-routes'
import { settingsRoutes } from './routes/settings-routes'

// Security model: same-origin serving + loopback binding + token auth.
// No CORS headers needed — the server only listens on 127.0.0.1 and the web
// client is served from the same origin. The token covers WS upgrades too via
// the ?token= query param (browsers cannot set headers on WS handshakes).

export function createApp({ data, sessions, token }: { data: AppData; sessions: SessionsService; token: string }): Hono {
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

  app.route('/api', api)

  app.get('/health', (c) => c.json({ ok: true }))

  return app
}
