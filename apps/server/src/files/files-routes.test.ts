import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitRun } from '../github/git-remote'
import { AppData } from '../store/app-data'
import { filesRoutes } from './files-routes'

/** AppData réel sur un tmpdir jetable (même motif que commands-routes.test.ts:12-16). */
function freshRoutes(gitRun: GitRun, projectPath = '/tmp/p1') {
  const data = new AppData(join(mkdtempSync(join(tmpdir(), 'atelier-files-')), 'data.json'))
  data.update((d) => { d.projects.push({ id: 'p1', path: projectPath, color: '#ffffff' }) })
  return filesRoutes(data, gitRun)
}

/** GitRun factice : renvoie la sortie NUL-séparée fournie (exitCode 0). */
const gitOk = (files: string[]): GitRun => async () => ({ stdout: files.join('\0'), stderr: '', exitCode: 0 })
const gitFail: GitRun = async () => ({ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 })

describe('GET /projects/:id/files', () => {
  test('fichiers triés + dossiers dérivés, chemins accentués intacts (NUL-séparé)', async () => {
    const app = freshRoutes(gitOk(['src/été.ts', 'src/lib/utils.ts', 'README.md']))
    const res = await app.request('/projects/p1/files')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      files: ['README.md', 'src/lib/utils.ts', 'src/été.ts'],
      dirs: ['src', 'src/lib'],
    })
  })

  test('404 sur projet inconnu', async () => {
    const app = freshRoutes(gitOk([]))
    expect((await app.request('/projects/nope/files')).status).toBe(404)
  })

  test('fallback glob quand git échoue (répertoire non-git), .git/node_modules exclus', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atelier-nogit-'))
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, 'src', 'a.ts'), '')
    writeFileSync(join(root, 'node_modules', 'x', 'b.js'), '')
    writeFileSync(join(root, '.git', 'HEAD'), '')
    const app = freshRoutes(gitFail, root)
    const res = await app.request('/projects/p1/files')
    expect(await res.json()).toEqual({ files: ['src/a.ts'], dirs: ['src'] })
  })

  test('200 avec listes vides quand git ET le fallback échouent (path inexistant)', async () => {
    const app = freshRoutes(gitFail, '/nonexistent/nope')
    const res = await app.request('/projects/p1/files')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: [], dirs: [] })
  })
})
