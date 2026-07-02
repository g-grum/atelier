import { Hono } from 'hono'
import type { AppData } from '../store/app-data'
import type { SessionsService } from './sessions-service'

export function sessionsRoutes(data: AppData, sessions: SessionsService): Hono {
  const app = new Hono()

  app.get('/projects/:id/sessions', async (c) => {
    const { id } = c.req.param()
    const project = data.get().projects.find((p) => p.id === id)
    if (!project) return c.json({ error: 'Not found' }, 404)
    const list = await sessions.list(id)
    return c.json(list)
  })

  app.post('/projects/:id/sessions', async (c) => {
    const { id } = c.req.param()
    const project = data.get().projects.find((p) => p.id === id)
    if (!project) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json<{ name?: string; model?: string }>()
    const draft = sessions.createDraft(id, { name: body.name, model: body.model })
    return c.json(draft, 201)
  })

  app.patch('/sessions/:id', async (c) => {
    const { id } = c.req.param()
    const body = await c.req.json<{ name?: string; model?: string }>()
    if (body.name !== undefined) await sessions.rename(id, body.name)
    if (body.model !== undefined) sessions.setModel(id, body.model)
    return c.json({ ok: true })
  })

  app.delete('/sessions/:id', (c) => {
    const { id } = c.req.param()
    sessions.deleteDraft(id)
    return new Response(null, { status: 204 })
  })

  app.get('/sessions/:id/messages', async (c) => {
    const { id } = c.req.param()
    const msgs = await sessions.messages(id)
    return c.json(msgs)
  })

  return app
}
