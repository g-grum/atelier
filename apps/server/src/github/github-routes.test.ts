import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from '../store/app-data'
import { GithubService } from './github-service'
import type { GitRun } from './git-remote'
import { githubRoutes } from './github-routes'

const noopGithub = () => new GithubService(async () => ({ stdout: '', stderr: 'unused', exitCode: 1 }))

function freshData() {
  const data = new AppData(join(mkdtempSync(join(tmpdir(), 'atelier-gh-')), 'data.json'))
  data.update((draft) => {
    draft.projects.push({ id: 'p1', path: '/work/atelier', color: 'cyan' })
  })
  return data
}

describe('GET /projects/:id/github-account', () => {
  test('returns the account and repo derived from origin', async () => {
    const gitRun: GitRun = async () => ({ stdout: 'git@github.com-g-grum:g-grum/atelier.git\n', stderr: '', exitCode: 0 })
    const app = githubRoutes(noopGithub(), freshData(), gitRun)
    const res = await app.request('/projects/p1/github-account')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ account: 'g-grum', repo: 'g-grum/atelier' })
  })

  test('runs git in the project directory', async () => {
    const cwds: string[] = []
    const gitRun: GitRun = async (_args, cwd) => {
      cwds.push(cwd)
      return { stdout: 'git@github.com:o/r.git', stderr: '', exitCode: 0 }
    }
    const app = githubRoutes(noopGithub(), freshData(), gitRun)
    await app.request('/projects/p1/github-account')
    expect(cwds).toEqual(['/work/atelier'])
  })

  test('no GitHub origin → { account: null, repo: null } (never an error)', async () => {
    const gitRun: GitRun = async () => ({ stdout: '', stderr: 'error: No such remote', exitCode: 2 })
    const app = githubRoutes(noopGithub(), freshData(), gitRun)
    const res = await app.request('/projects/p1/github-account')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ account: null, repo: null })
  })

  test('unknown project → 404', async () => {
    const gitRun: GitRun = async () => ({ stdout: '', stderr: '', exitCode: 0 })
    const app = githubRoutes(noopGithub(), freshData(), gitRun)
    const res = await app.request('/projects/nope/github-account')
    expect(res.status).toBe(404)
  })
})
