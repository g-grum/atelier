import { Hono } from 'hono'
import type { ProjectFileList } from '@atelier/shared'
import { createGitRunner, type GitRun } from '../github/git-remote'
import type { AppData } from '../store/app-data'

/** Plafond global de la réponse (spec) — fichiers prioritaires, dossiers en remplissage. */
const MAX_ENTRIES = 20_000

/**
 * Listing des fichiers d'un projet pour l'autocomplétion @ du composer.
 * `git ls-files -z` (respecte .gitignore, inclut les non-suivis, NUL-séparé
 * pour éviter le C-quoting des chemins accentués) ; fallback Bun.Glob hors
 * repo git. Dossiers dérivés des chemins AVANT troncature (spec).
 */
export async function listProjectFiles(run: GitRun, path: string): Promise<ProjectFileList> {
  const result = await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], path)
  const files = result.exitCode === 0
    ? result.stdout.split('\0').filter((f) => f !== '')
    : await globFallback(path)
  files.sort()
  const dirs = deriveDirs(files)
  const cappedFiles = files.slice(0, MAX_ENTRIES)
  return { files: cappedFiles, dirs: dirs.slice(0, MAX_ENTRIES - cappedFiles.length) }
}

/** Ensemble des dossiers parents (sans slash final), triés. */
function deriveDirs(files: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const file of files) {
    let slash = file.indexOf('/')
    while (slash !== -1) {
      dirs.add(file.slice(0, slash))
      slash = file.indexOf('/', slash + 1)
    }
  }
  return [...dirs].sort()
}

/** Hors repo git : parcours glob en excluant les répertoires générés. */
async function globFallback(root: string): Promise<string[]> {
  const out: string[] = []
  try {
    for await (const file of new Bun.Glob('**/*').scan({ cwd: root })) {
      if (file.startsWith('.git/') || file.includes('node_modules/') || /^dist[^/]*\//.test(file)) continue
      out.push(file)
      if (out.length >= MAX_ENTRIES) break
    }
  } catch {
    return []
  }
  return out
}

/**
 * Résolution de l'id inlinée comme commands-routes.ts:17-20 (aucun résolveur
 * partagé au HEAD). Échec du listing ⇒ listes vides, jamais de 500 : sans
 * liste, le composer redevient une textarea ordinaire.
 */
export function filesRoutes(data: AppData, gitRun: GitRun = createGitRunner()): Hono {
  const app = new Hono()

  app.get('/projects/:id/files', async (c) => {
    const { id } = c.req.param()
    const project = data.get().projects.find((p) => p.id === id)
    if (!project) return c.json({ error: 'Not found' }, 404)
    try {
      return c.json(await listProjectFiles(gitRun, project.path))
    } catch {
      return c.json({ files: [], dirs: [] })
    }
  })

  return app
}
