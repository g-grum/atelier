import { describe, expect, test } from 'bun:test'
import { GithubError, GithubService } from './github-service'
import type { GhRun } from './gh-runner'

const RAW_PR = {
  number: 1276,
  title: 'SUP-90 - Fix frozen page',
  url: 'https://github.com/o/r/pull/1276',
  author: { login: 'alice-dev' },
  state: 'MERGED',
  isDraft: false,
  updatedAt: '2026-07-17T12:22:41Z',
  headRefName: 'fix/sup-90',
  reviewDecision: 'APPROVED',
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
}

type Call = { args: string[]; env: Record<string, string> | undefined }

function fakeRunner(responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) {
  const calls: Call[] = []
  const run: GhRun = async (args, env) => {
    calls.push({ args, env })
    const key = args[0] === 'auth' ? 'auth' : 'list'
    const r = responses[key] ?? {}
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 }
  }
  return { run, calls }
}

const okRunner = () => fakeRunner({ auth: { stdout: 'tok-123\n' }, list: { stdout: JSON.stringify([RAW_PR]) } })

describe('GithubService', () => {
  test('lists PRs with the pinned token and maps fields', async () => {
    const { run, calls } = okRunner()
    const service = new GithubService(run, () => 0)
    const prs = await service.listPrs('o/r', 10, 'alice-dev')
    expect(calls[0]!.args).toEqual(['auth', 'token', '--user', 'alice-dev'])
    expect(calls[1]!.env).toEqual({ GH_TOKEN: 'tok-123' })
    expect(calls[1]!.args).toContain('--state')
    expect(prs).toEqual([{
      number: 1276,
      title: 'SUP-90 - Fix frozen page',
      url: 'https://github.com/o/r/pull/1276',
      author: 'alice-dev',
      state: 'merged',
      updatedAt: '2026-07-17T12:22:41Z',
      branch: 'fix/sup-90',
      ci: 'passed',
      review: 'approved',
    }])
  })

  test.each([
    ['draft', { ...RAW_PR, state: 'OPEN', isDraft: true }, 'draft'],
    ['open', { ...RAW_PR, state: 'OPEN', isDraft: false }, 'open'],
    ['closed', { ...RAW_PR, state: 'CLOSED' }, 'closed'],
  ] as const)('state mapping: %s', async (_n, raw, expected) => {
    const { run } = fakeRunner({ auth: { stdout: 't' }, list: { stdout: JSON.stringify([raw]) } })
    const prs = await new GithubService(run, () => 0).listPrs('o/r', 10, 'u')
    expect(prs[0]!.state).toBe(expected)
  })

  test.each([
    ['null when no checks', [], null],
    ['failed beats pending', [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }], 'failed'],
    ['pending when any incomplete', [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }], 'pending'],
    ['passed when all green', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], 'passed'],
  ] as const)('ci mapping: %s', async (_n, rollup, expected) => {
    const { run } = fakeRunner({ auth: { stdout: 't' }, list: { stdout: JSON.stringify([{ ...RAW_PR, statusCheckRollup: rollup }]) } })
    const prs = await new GithubService(run, () => 0).listPrs('o/r', 10, 'u')
    expect(prs[0]!.ci).toBe(expected)
  })

  test('review mapping: CHANGES_REQUESTED / REVIEW_REQUIRED / empty', async () => {
    for (const [decision, expected] of [['CHANGES_REQUESTED', 'changes_requested'], ['REVIEW_REQUIRED', 'required'], ['', null]] as const) {
      const { run } = fakeRunner({ auth: { stdout: 't' }, list: { stdout: JSON.stringify([{ ...RAW_PR, reviewDecision: decision }]) } })
      const prs = await new GithubService(run, () => 0).listPrs('o/r', 10, 'u')
      expect(prs[0]!.review).toBe(expected)
    }
  })

  test('cache: same repo:limit within 60s does not re-run gh; expiry re-fetches', async () => {
    let now = 0
    const { run, calls } = okRunner()
    const service = new GithubService(run, () => now)
    await service.listPrs('o/r', 10, 'u')
    await service.listPrs('o/r', 10, 'u')
    expect(calls.filter((c) => c.args[0] === 'pr')).toHaveLength(1)
    now = 61_000
    await service.listPrs('o/r', 10, 'u')
    expect(calls.filter((c) => c.args[0] === 'pr')).toHaveLength(2)
  })

  test('token cached per user; changing githubUser re-resolves', async () => {
    const { run, calls } = okRunner()
    const service = new GithubService(run, () => 0)
    await service.listPrs('o/r', 10, 'user-a')
    await service.listPrs('o/r2', 10, 'user-a')
    await service.listPrs('o/r3', 10, 'user-b')
    expect(calls.filter((c) => c.args[0] === 'auth')).toHaveLength(2)
  })

  test('auth failure and gh failure throw GithubError with actionable French messages', async () => {
    // await is REQUIRED on .rejects — unawaited, the assertion can silently pass.
    const authFail = fakeRunner({ auth: { exitCode: 1, stderr: 'no oauth token' } })
    await expect(new GithubService(authFail.run, () => 0).listPrs('o/r', 10, 'u')).rejects.toThrow(GithubError)
    const listFail = fakeRunner({ auth: { stdout: 't' }, list: { exitCode: 1, stderr: 'GraphQL: Could not resolve' } })
    await expect(new GithubService(listFail.run, () => 0).listPrs('o/r', 10, 'u')).rejects.toThrow('Could not resolve')
  })

  test('gh missing (exit 127 from the runner) surfaces the runner message, not a misleading auth error', async () => {
    const missing = fakeRunner({ auth: { exitCode: 127, stderr: 'gh introuvable (/opt/homebrew/bin/gh) — installe GitHub CLI : brew install gh' } })
    await expect(new GithubService(missing.run, () => 0).listPrs('o/r', 10, 'u')).rejects.toThrow('gh introuvable')
  })

  test('errors are not cached — the next call retries', async () => {
    const responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }> = { auth: { stdout: 't' }, list: { exitCode: 1, stderr: 'boom' } }
    const { run, calls } = fakeRunner(responses)
    const service = new GithubService(run, () => 0)
    await service.listPrs('o/r', 10, 'u').catch(() => {})
    responses.list = { stdout: JSON.stringify([RAW_PR]) }
    const prs = await service.listPrs('o/r', 10, 'u')
    expect(prs).toHaveLength(1)
    expect(calls.filter((c) => c.args[0] === 'pr')).toHaveLength(2)
  })
})
