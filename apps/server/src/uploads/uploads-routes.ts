import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AppData } from '../store/app-data'
import { extensionForMime, MAX_IMAGE_BYTES } from './image-uploads'

/**
 * Upload d'image dans le dossier scratch du projet (spec 2026-08-13).
 * L'agent lira l'image via Read ; le chemin relatif retourné est inséré dans
 * le prompt côté composer. Résolution d'id inline (motif files-routes.ts).
 */
export function uploadsRoutes(data: AppData): Hono {
  const app = new Hono()

  app.post('/projects/:id/uploads', async (c) => {
    const project = data.get().projects.find((p) => p.id === c.req.param('id'))
    if (!project) return c.json({ error: 'Not found' }, 404)

    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File) || file.size === 0) return c.json({ error: 'Aucun fichier' }, 400)

    const ext = extensionForMime(file.type)
    if (ext === null) return c.json({ error: 'Type de fichier non supporté' }, 400)
    if (file.size > MAX_IMAGE_BYTES) return c.json({ error: 'Image trop volumineuse (max 10 Mo)' }, 400)

    const dir = join(project.path, '.atelier', 'uploads')
    await mkdir(dir, { recursive: true })
    // Auto-ignore : .atelier/.gitignore = "*" (créé une fois). `*` matche aussi
    // les dotfiles → tout .atelier/ est ignoré sans toucher le .gitignore racine.
    const ignore = join(project.path, '.atelier', '.gitignore')
    if (!existsSync(ignore)) await writeFile(ignore, '*\n')

    const name = `${randomUUID()}.${ext}`
    await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()))
    return c.json({ path: `.atelier/uploads/${name}` })
  })

  return app
}
