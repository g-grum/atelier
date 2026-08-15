import { Hono } from 'hono'
import type { DevServerMonitor } from './dev-server-monitor'

/**
 * Stop endpoint for session-spawned dev servers (spec 2026-08-14). The
 * monitor's last scan is the authorization source — only processes it saw as
 * killable (descendants of the Atelier server) can be SIGTERMed.
 */
export function devServersRoutes(monitor: DevServerMonitor): Hono {
  const app = new Hono()

  app.post('/dev-servers/:pid/stop', (c) => {
    const raw = c.req.param('pid')
    if (!/^\d+$/.test(raw)) return c.json({ error: 'Invalid pid' }, 400)
    switch (monitor.stop(Number(raw))) {
      case 'stopped':
        return c.body(null, 204)
      case 'forbidden':
        return c.json({ error: 'Not stoppable' }, 403)
      case 'unknown':
        return c.json({ error: 'Unknown pid' }, 404)
    }
  })

  return app
}
