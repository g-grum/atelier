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

/** Helper séquentiel : une file de réponses, consommées appel par appel (le fake historique route par args[0] et ne sait pas varier). */
function sequentialRunner(queue: { stdout?: string; stderr?: string; exitCode?: number }[]) {
  const calls: Call[] = []
  const run: GhRun = async (args, env) => {
    calls.push({ args, env })
    const r = queue.shift() ?? {}
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 }
  }
  return { run, calls }
}

describe('listAutopilotIssues', () => {
  test('liste les issues ouvertes labellisées autopilot, triées par ancienneté', async () => {
    const { run, calls } = fakeRunner({
      auth: { stdout: 'tok\n' },
      list: { stdout: JSON.stringify([
        { number: 12, title: 'B', createdAt: '2026-08-02T00:00:00Z' },
        { number: 7, title: 'A', createdAt: '2026-08-01T00:00:00Z' },
      ]) },
    })
    const issues = await new GithubService(run, () => 0).listAutopilotIssues('g-grum/atelier', 'g-grum')
    expect(issues).toEqual([{ number: 7, title: 'A' }, { number: 12, title: 'B' }])
    expect(calls[1]!.args).toEqual(['issue', 'list', '-R', 'g-grum/atelier', '--label', 'autopilot', '--state', 'open', '--json', 'number,title,createdAt'])
    expect(calls[1]!.env).toEqual({ GH_TOKEN: 'tok' })
  })

  test('gh en échec → GithubError FR', async () => {
    const { run } = fakeRunner({ auth: { stdout: 't' }, list: { exitCode: 1, stderr: 'boom' } })
    expect(new GithubService(run, () => 0).listAutopilotIssues('o/r', 'u')).rejects.toThrow('gh a échoué pour o/r : boom')
  })
})

describe('prForBranch', () => {
  test('retourne la première PR de la branche, SANS cache (deux appels = deux exécutions gh)', async () => {
    const { run, calls } = sequentialRunner([
      { stdout: 'tok\n' },
      { stdout: '[]' },
      { stdout: JSON.stringify([{ number: 5, url: 'https://github.com/o/r/pull/5' }]) },
    ])
    const service = new GithubService(run, () => 0)
    expect(await service.prForBranch('o/r', 'autopilot/5', 'u')).toBeNull()
    expect(await service.prForBranch('o/r', 'autopilot/5', 'u')).toEqual({ number: 5, url: 'https://github.com/o/r/pull/5' })
    // 3 appels gh : 1 token + 2 pr list — aucun cache
    expect(calls).toHaveLength(3)
    expect(calls[1]!.args).toEqual(['pr', 'list', '-R', 'o/r', '--head', 'autopilot/5', '--state', 'all', '--json', 'number,url'])
  })

  test('réponse illisible → GithubError FR', async () => {
    const { run } = fakeRunner({ auth: { stdout: 't' }, list: { stdout: 'pas du json' } })
    expect(new GithubService(run, () => 0).prForBranch('o/r', 'b', 'u')).rejects.toThrow('réponse gh illisible pour o/r')
  })
})

describe('prCi', () => {
  test('interroge statusCheckRollup avec les bons arguments', async () => {
    const { run, calls } = fakeRunner({ auth: { stdout: 'tok\n' }, list: { stdout: JSON.stringify({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }) } })
    expect(await new GithubService(run, () => 0).prCi('o/r', 42, 'u')).toBe('passed')
    expect(calls[1]!.args).toEqual(['pr', 'view', '42', '-R', 'o/r', '--json', 'statusCheckRollup'])
    expect(calls[1]!.env).toEqual({ GH_TOKEN: 'tok' })
  })

  test.each([
    ['failed si un check FAILURE', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }], 'failed'],
    ['failed si un check ERROR', [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'ERROR' }], 'failed'],
    ['pending si un check incomplet', [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }], 'pending'],
    ['null si aucun check', [], null],
    ['null si rollup null', null, null],
  ] as const)('mapping CI : %s', async (_n, rollup, expected) => {
    const { run } = fakeRunner({ auth: { stdout: 't' }, list: { stdout: JSON.stringify({ statusCheckRollup: rollup }) } })
    expect(await new GithubService(run, () => 0).prCi('o/r', 42, 'u')).toBe(expected)
  })

  test('rollup absent → null', async () => {
    const { run } = fakeRunner({ auth: { stdout: 't' }, list: { stdout: '{}' } })
    expect(await new GithubService(run, () => 0).prCi('o/r', 42, 'u')).toBeNull()
  })

  test('gh en échec → GithubError FR', async () => {
    const { run } = fakeRunner({ auth: { stdout: 't' }, list: { exitCode: 1, stderr: 'boom' } })
    await expect(new GithubService(run, () => 0).prCi('o/r', 42, 'u')).rejects.toThrow('gh a échoué pour o/r : boom')
  })
})

describe('mergePr', () => {
  test('merge squash avec suppression de branche, token épinglé en env', async () => {
    const { run, calls } = fakeRunner({ auth: { stdout: 'tok\n' } })
    await new GithubService(run, () => 0).mergePr('o/r', 42, 'u')
    expect(calls[1]!.args).toEqual(['pr', 'merge', '42', '-R', 'o/r', '--squash', '--delete-branch'])
    expect(calls[1]!.env).toEqual({ GH_TOKEN: 'tok' })
  })

  test('gh en échec → GithubError avec le stderr', async () => {
    const { run } = fakeRunner({ auth: { stdout: 't' }, list: { exitCode: 1, stderr: 'Pull request is not mergeable' } })
    await expect(new GithubService(run, () => 0).mergePr('o/r', 42, 'u')).rejects.toThrow('gh a échoué pour o/r : Pull request is not mergeable')
  })
})

describe('issueBody', () => {
  test('récupère le corps de l’issue', async () => {
    const { run, calls } = fakeRunner({ auth: { stdout: 'tok\n' }, list: { stdout: JSON.stringify({ body: 'faire X' }) } })
    expect(await new GithubService(run, () => 0).issueBody('o/r', 42, 'u')).toBe('faire X')
    expect(calls[1]!.args).toEqual(['issue', 'view', '42', '-R', 'o/r', '--json', 'body'])
  })
})
