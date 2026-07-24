import { Hono } from 'hono'
import { REPO_PATTERN } from '@atelier/shared'
import type { AppData } from '../store/app-data'
import { GithubError, GithubService } from './github-service'
import { createGitRunner, type GitRun, projectGithubAccount } from './git-remote'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30

export function githubRoutes(github: GithubService, data: AppData, gitRun: GitRun = createGitRunner()): Hono {
  const app = new Hono()

  // Which GitHub account a project pushes as, derived from its `origin` remote.
  // Read-only and never fatal: an absent/foreign/unreadable remote is a normal
  // state → { account: null } (the topbar chip simply hides), not an error.
  app.get('/projects/:id/github-account', async (c) => {
    const project = data.get().projects.find((p) => p.id === c.req.param('id'))
    if (project === undefined) return c.json({ error: 'Not found' }, 404)
    const remote = await projectGithubAccount(gitRun, project.path)
    return c.json(remote ?? { account: null, repo: null })
  })

  // Read-only proxy: all failures land as 400 (caller bug) or 502 (gh/GitHub
  // unavailable) with a French, widget-displayable { error } — never a 500.
  app.get('/github/prs', async (c) => {
    const repo = c.req.query('repo') ?? ''
    if (!REPO_PATTERN.test(repo)) {
      return c.json({ error: 'requête invalide : « repo » doit être de la forme owner/repo' }, 400)
    }
    const limitRaw = c.req.query('limit')
    const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return c.json({ error: `requête invalide : « limit » doit être un entier entre 1 et ${MAX_LIMIT}` }, 400)
    }
    try {
      return c.json(await github.listPrs(repo, limit, data.get().preferences.githubUser))
    } catch (err) {
      if (err instanceof GithubError) return c.json({ error: err.message }, 502)
      console.error('[github-routes] unexpected failure:', err)
      return c.json({ error: 'erreur inattendue en interrogeant GitHub' }, 502)
    }
  })

  return app
}
