import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { AppData } from '../store/app-data'
import { openInIde, spawnLaunch, type LaunchFn } from '../ide/open-in-ide'

const COLOR_PALETTE = ['cyan', 'magenta', 'violet', 'mint', 'amber'] as const

export function settingsRoutes(data: AppData, launch: LaunchFn = spawnLaunch): Hono {
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

  // Open in IDE — always 200 with { ok } : the web toast consumes `reason`, a 500 would break it.
  app.post('/open-in-ide', async (c) => {
    let body: { file?: unknown; line?: unknown }
    try {
      body = await c.req.json<{ file?: unknown; line?: unknown }>()
    } catch {
      return c.json({ ok: false, reason: 'requête invalide : corps JSON attendu' })
    }
    if (typeof body.file !== 'string' || body.file.length === 0) {
      return c.json({ ok: false, reason: 'requête invalide : « file » (chemin absolu) est requis' })
    }
    const line = typeof body.line === 'number' ? body.line : undefined
    const result = await openInIde({ ide: data.get().preferences.ide, file: body.file, line, launch })
    return c.json(result)
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
