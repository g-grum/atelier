import { describe, expect, test } from 'bun:test'
import { parseGithubRemote, projectGithubAccount } from './git-remote'
import type { GitRun } from './git-remote'

describe('parseGithubRemote', () => {
  test('SSH host alias github.com-<account> → account is the alias suffix', () => {
    expect(parseGithubRemote('git@github.com-g-grum:g-grum/atelier.git')).toEqual({ account: 'g-grum', repo: 'g-grum/atelier' })
  })

  test('SSH alias distinct from the repo owner keeps the alias as the account', () => {
    expect(parseGithubRemote('git@github.com-work:acme/backend.git')).toEqual({ account: 'work', repo: 'acme/backend' })
  })

  test('plain SSH remote → account falls back to the repo owner', () => {
    expect(parseGithubRemote('git@github.com:octocat/hello.git')).toEqual({ account: 'octocat', repo: 'octocat/hello' })
  })

  test('HTTPS remote → account falls back to the repo owner', () => {
    expect(parseGithubRemote('https://github.com/octocat/hello.git')).toEqual({ account: 'octocat', repo: 'octocat/hello' })
  })

  test('remote without a trailing .git is still parsed', () => {
    expect(parseGithubRemote('git@github.com:octocat/hello')).toEqual({ account: 'octocat', repo: 'octocat/hello' })
  })

  test('non-GitHub host → null', () => {
    expect(parseGithubRemote('git@gitlab.com:octocat/hello.git')).toBeNull()
  })

  test('empty or garbage → null', () => {
    expect(parseGithubRemote('')).toBeNull()
    expect(parseGithubRemote('   ')).toBeNull()
    expect(parseGithubRemote('not a url')).toBeNull()
  })
})

describe('projectGithubAccount', () => {
  const fakeRun = (result: { stdout?: string; stderr?: string; exitCode?: number }): GitRun => async () => ({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 0,
  })

  test('reads origin and parses the account', async () => {
    const run = fakeRun({ stdout: 'git@github.com-g-grum:g-grum/atelier.git\n' })
    expect(await projectGithubAccount(run, '/some/project')).toEqual({ account: 'g-grum', repo: 'g-grum/atelier' })
  })

  test('runs git remote get-url origin in the project directory', async () => {
    const calls: { args: string[]; cwd: string }[] = []
    const run: GitRun = async (args, cwd) => {
      calls.push({ args, cwd })
      return { stdout: 'git@github.com:o/r.git', stderr: '', exitCode: 0 }
    }
    await projectGithubAccount(run, '/work/atelier')
    expect(calls[0]!.args).toEqual(['remote', 'get-url', 'origin'])
    expect(calls[0]!.cwd).toBe('/work/atelier')
  })

  test('no origin remote (git exits non-zero) → null', async () => {
    const run = fakeRun({ exitCode: 2, stderr: 'error: No such remote' })
    expect(await projectGithubAccount(run, '/some/project')).toBeNull()
  })

  test('non-GitHub origin → null', async () => {
    const run = fakeRun({ stdout: 'git@gitlab.com:o/r.git\n' })
    expect(await projectGithubAccount(run, '/some/project')).toBeNull()
  })
})
