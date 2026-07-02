import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { AppData } from '../store/app-data'

const COLOR_PALETTE = ['cyan', 'magenta', 'violet', 'mint', 'amber'] as const

export function settingsRoutes(data: AppData): Hono {
  const app = new Hono()

  // Projects
  app.get('/projects', (c) => {
    return c.json(data.get().projects)
  })

  app.post('/projects', async (c) => {
    const body = await c.req.json<{ path: string }>()
    const id = randomUUID()
    const { projects } = data.get()
    const color = COLOR_PALETTE[projects.length % COLOR_PALETTE.length] as string
    const project = { id, path: body.path, color }
    data.update((d) => {
      d.projects.push(project)
    })
    return c.json(project, 201)
  })

  app.delete('/projects/:id', (c) => {
    const { id } = c.req.param()
    data.update((d) => {
      d.projects = d.projects.filter((p) => p.id !== id)
    })
    return new Response(null, { status: 204 })
  })

  // Preferences
  app.get('/preferences', (c) => {
    return c.json(data.get().preferences)
  })

  app.patch('/preferences', async (c) => {
    const body = await c.req.json<Partial<{ ide: string; defaultModel: string }>>()
    data.update((d) => {
      if (body.ide !== undefined) d.preferences.ide = body.ide as typeof d.preferences.ide
      if (body.defaultModel !== undefined) d.preferences.defaultModel = body.defaultModel
    })
    return c.json(data.get().preferences)
  })

  // Rules
  app.get('/rules', (c) => {
    return c.json(data.get().rules)
  })

  app.delete('/rules/:id', (c) => {
    const { id } = c.req.param()
    data.update((d) => {
      d.rules = d.rules.filter((r) => r.id !== id)
    })
    return new Response(null, { status: 204 })
  })

  return app
}
