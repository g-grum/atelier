import { SESSION_PERMISSION_MODES, type SessionPermissionMode } from '@atelier/shared'
import { Hono } from 'hono'
import { readJsonObject } from '../routes/read-json'
import type { AppData } from '../store/app-data'
import { SessionNotFoundError, type SessionsService } from './sessions-service'

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
    // Same body-guard class as settings-routes: JSON.parse also succeeds on
    // 'null', '[]', '"x"', '42', 'true' — any legal JSON body → 4xx, never a 500.
    const body = await readJsonObject(c.req)
    if (body === null) return c.json({ error: 'requête invalide : objet JSON attendu' }, 400)
    if (body.name !== undefined && typeof body.name !== 'string') {
      return c.json({ error: 'requête invalide : « name » doit être une chaîne' }, 400)
    }
    if (body.model !== undefined && typeof body.model !== 'string') {
      return c.json({ error: 'requête invalide : « model » doit être une chaîne' }, 400)
    }
    const draft = sessions.createDraft(id, { name: body.name, model: body.model })
    return c.json(draft, 201)
  })

  app.patch('/sessions/:id', async (c) => {
    const { id } = c.req.param()
    const body = await readJsonObject(c.req)
    if (body === null) return c.json({ error: 'requête invalide : objet JSON attendu' }, 400)
    if (body.name !== undefined && typeof body.name !== 'string') {
      return c.json({ error: 'requête invalide : « name » doit être une chaîne' }, 400)
    }
    if (body.model !== undefined && typeof body.model !== 'string') {
      return c.json({ error: 'requête invalide : « model » doit être une chaîne' }, 400)
    }
    if (body.permissionMode !== undefined && !SESSION_PERMISSION_MODES.includes(body.permissionMode as SessionPermissionMode)) {
      return c.json({ error: 'requête invalide : « permissionMode » doit être default ou bypassPermissions' }, 400)
    }
    if (body.name !== undefined) await sessions.rename(id, body.name)
    if (body.model !== undefined) sessions.setModel(id, body.model)
    if (body.permissionMode !== undefined) sessions.setPermissionMode(id, body.permissionMode as SessionPermissionMode)
    return c.json({ ok: true })
  })

  app.delete('/sessions/:id', async (c) => {
    const { id } = c.req.param()
    try {
      await sessions.delete(id)
    } catch (err) {
      if (err instanceof SessionNotFoundError) return c.json({ error: 'Session introuvable' }, 404)
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return new Response(null, { status: 204 })
  })

  app.get('/sessions/:id/messages', async (c) => {
    const { id } = c.req.param()
    const msgs = await sessions.messages(id)
    return c.json(msgs)
  })

  return app
}
