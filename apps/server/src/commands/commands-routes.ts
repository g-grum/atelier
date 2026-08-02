import { Hono } from 'hono'
import type { SdkClient } from '../sdk/sdk-client'
import type { AppData } from '../store/app-data'

/**
 * Slash commands d'un projet, via la sonde SDK.
 *
 * Résolution de l'id : il n'existe AUCUN résolveur partagé au HEAD —
 * sessions-routes.ts:12 et github-routes.ts:17 inlinent chacun leur
 * projects.find. On fait de même. Conséquence assumée : un id de worktree
 * (`wt:`) donne 404 tant que le plan worktrees n'a pas atterri ; cette route
 * sera alors un sixième site à élargir, pas un travail nouveau.
 */
export function commandsRoutes(data: AppData, sdk: SdkClient): Hono {
  const app = new Hono()

  app.get('/projects/:id/commands', async (c) => {
    const { id } = c.req.param()
    const project = data.get().projects.find((p) => p.id === id)
    if (!project) return c.json({ error: 'Not found' }, 404)
    // Ceinture et bretelles : listCommands ne jette pas, mais un throw ici
    // priverait le composer de sa liste ET renverrait un 500 pour un confort.
    try {
      return c.json(await sdk.listCommands(project.path))
    } catch {
      return c.json([])
    }
  })

  return app
}
