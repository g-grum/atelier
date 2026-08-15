import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import type { AppData } from '../store/app-data'
import { normalizeToProject } from './artifact-lib'

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

/**
 * Serves session-artifact bytes (spec 2026-08-14). Project-scoped and
 * image-only: the path is normalized against the project root (anti-traversal
 * mirror of the uploads guard) and only known image extensions are served.
 */
export function artifactsRoutes(data: AppData): Hono {
  const app = new Hono()

  app.get('/projects/:id/artifacts', async (c) => {
    const project = data.get().projects.find((p) => p.id === c.req.param('id'))
    if (!project) return c.json({ error: 'Not found' }, 404)

    const raw = c.req.query('path')
    if (raw === undefined || raw === '') return c.json({ error: 'Missing path' }, 400)

    const ext = raw.split('.').pop()?.toLowerCase() ?? ''
    const contentType = CONTENT_TYPES[ext]
    if (contentType === undefined) return c.json({ error: 'Not an image' }, 400)

    const rel = normalizeToProject(project.path, raw)
    if (rel === null) return c.json({ error: 'Invalid path' }, 400)

    const abs = resolve(project.path, rel)
    if (!existsSync(abs)) return c.json({ error: 'Not found' }, 404)

    // Bytes read eagerly: hono's request() harness stringifies a lazy BunFile body.
    return c.body(await Bun.file(abs).arrayBuffer(), 200, { 'content-type': contentType })
  })

  return app
}
