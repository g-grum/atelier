import { Hono } from 'hono'
import type { AppData } from '../store/app-data'
import { createGitRunner, type GitRun, projectGithubAccount } from '../github/git-remote'
import { AutopilotConflictError, type AutopilotRunner } from './autopilot-runner'

const DEFAULT_MAX_ITEMS = 3
const MAX_MAX_ITEMS = 10

/** Routes autopilot (spec 2026-08-05). Erreurs FR affichables dans le widget — jamais de 500 pour un cas prévu. */
export function autopilotRoutes(runner: AutopilotRunner, data: AppData, gitRun: GitRun = createGitRunner()): Hono {
  const app = new Hono()

  app.get('/autopilot', (c) => c.json(data.get().autopilot))

  app.post('/autopilot/start', async (c) => {
    let body: { projectId?: unknown; maxItems?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: 'requête invalide : corps JSON attendu' }, 400)
    }
    const projectId = typeof body.projectId === 'string' ? body.projectId : ''
    const project = data.get().projects.find((p) => p.id === projectId)
    if (project === undefined) return c.json({ error: 'projet introuvable' }, 404)

    const maxItems = body.maxItems === undefined ? DEFAULT_MAX_ITEMS : Number(body.maxItems)
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_MAX_ITEMS) {
      return c.json({ error: `requête invalide : « maxItems » doit être un entier entre 1 et ${MAX_MAX_ITEMS}` }, 400)
    }

    const remote = await projectGithubAccount(gitRun, project.path)
    if (remote?.repo == null) {
      return c.json({ error: 'ce projet n’a pas de remote GitHub — l’autopilot a besoin d’un repo pour lire les issues et ouvrir les PRs' }, 400)
    }

    try {
      runner.start({ projectId, repo: remote.repo, githubUser: data.get().preferences.githubUser, maxItems })
    } catch (err) {
      if (err instanceof AutopilotConflictError) return c.json({ error: 'un run autopilot est déjà en cours' }, 409)
      throw err
    }
    return c.json({ ok: true }, 202)
  })

  app.post('/autopilot/stop', (c) => {
    runner.stop()
    return c.json({ ok: true }, 202)
  })

  app.post('/autopilot/cleanup', async (c) => {
    await runner.cleanup()
    return c.json({ ok: true }, 200)
  })

  return app
}
