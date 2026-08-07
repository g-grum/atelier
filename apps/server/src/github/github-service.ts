import type { PrCi, PrReview, PrState, PrSummary } from '@atelier/shared'
import type { GhRun } from './gh-runner'

/** Actionable, user-displayable failure (→ 502 { error }); anything else is a bug. */
export class GithubError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubError'
  }
}

const CACHE_TTL_MS = 60_000
const FIELDS = 'number,title,url,author,state,isDraft,updatedAt,headRefName,reviewDecision,statusCheckRollup'

type RawPr = {
  number: number
  title: string
  url: string
  author?: { login?: string }
  state: string
  isDraft?: boolean
  updatedAt: string
  headRefName?: string
  reviewDecision?: string
  statusCheckRollup?: { status?: string; conclusion?: string }[] | null
}

export class GithubService {
  /** Token pinned per gh keyring user — immune to `gh auth switch` (release ops). */
  private token: { user: string; value: string } | null = null
  private readonly cache = new Map<string, { at: number; prs: PrSummary[] }>()

  constructor(
    private readonly run: GhRun,
    private readonly now: () => number = Date.now,
  ) {}

  async listPrs(repo: string, limit: number, githubUser: string): Promise<PrSummary[]> {
    const key = `${repo}:${limit}`
    const hit = this.cache.get(key)
    if (hit !== undefined && this.now() - hit.at < CACHE_TTL_MS) return hit.prs

    const token = await this.resolveToken(githubUser)
    const result = await this.run(
      ['pr', 'list', '-R', repo, '--state', 'all', '--limit', String(limit), '--json', FIELDS],
      { GH_TOKEN: token },
    )
    if (result.exitCode !== 0) {
      throw new GithubError(`gh a échoué pour ${repo} : ${result.stderr.trim() || 'erreur inconnue'}`)
    }
    let raw: RawPr[]
    try {
      raw = JSON.parse(result.stdout) as RawPr[]
    } catch {
      throw new GithubError(`réponse gh illisible pour ${repo}`)
    }
    const prs = raw.map(mapPr)
    this.cache.set(key, { at: this.now(), prs })
    return prs
  }

  /** Issues ouvertes labellisées autopilot, plus ancienne d'abord. AUCUN cache (spec 2026-08-05). */
  async listAutopilotIssues(repo: string, githubUser: string): Promise<{ number: number; title: string }[]> {
    const raw = await this.runJson<{ number: number; title: string; createdAt: string }[]>(
      ['issue', 'list', '-R', repo, '--label', 'autopilot', '--state', 'open', '--json', 'number,title,createdAt'],
      repo,
      githubUser,
    )
    return raw
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ number, title }) => ({ number, title }))
  }

  /** PR (tous états) dont la branche est `branch`. SANS cache — doit voir une PR toute fraîche (le cache 60 s de listPrs la manquerait). */
  async prForBranch(repo: string, branch: string, githubUser: string): Promise<{ number: number; url: string } | null> {
    const raw = await this.runJson<{ number: number; url: string }[]>(
      ['pr', 'list', '-R', repo, '--head', branch, '--state', 'all', '--json', 'number,url'],
      repo,
      githubUser,
    )
    return raw[0] ?? null
  }

  /** État CI d'une PR. SANS cache — sert au poll pré-merge (spec 2026-08-07). */
  async prCi(repo: string, number: number, githubUser: string): Promise<PrCi> {
    const raw = await this.runJson<{ statusCheckRollup?: { status?: string; conclusion?: string }[] | null }>(
      ['pr', 'view', String(number), '-R', repo, '--json', 'statusCheckRollup'],
      repo,
      githubUser,
    )
    return mapCi(raw.statusCheckRollup)
  }

  /** Corps d'une issue (prompt d'item autopilot). SANS cache. */
  async issueBody(repo: string, issue: number, githubUser: string): Promise<string> {
    const raw = await this.runJson<{ body?: string }>(
      ['issue', 'view', String(issue), '-R', repo, '--json', 'body'],
      repo,
      githubUser,
    )
    return raw.body ?? ''
  }

  /** Exécute gh avec le token épinglé et parse le JSON — conventions d'erreur FR communes. */
  private async runJson<T>(args: string[], repo: string, githubUser: string): Promise<T> {
    const token = await this.resolveToken(githubUser)
    const result = await this.run(args, { GH_TOKEN: token })
    if (result.exitCode !== 0) {
      throw new GithubError(`gh a échoué pour ${repo} : ${result.stderr.trim() || 'erreur inconnue'}`)
    }
    try {
      return JSON.parse(result.stdout) as T
    } catch {
      throw new GithubError(`réponse gh illisible pour ${repo}`)
    }
  }

  private async resolveToken(user: string): Promise<string> {
    if (this.token !== null && this.token.user === user) return this.token.value
    const result = await this.run(['auth', 'token', '--user', user])
    const value = result.stdout.trim()
    if (result.exitCode !== 0 || value.length === 0) {
      const detail = result.stderr.trim()
      // exit 127 = the runner itself failed (gh binary missing) — its message
      // is already actionable; a « pas authentifié » prefix would mislead.
      if (result.exitCode === 127 && detail.length > 0) throw new GithubError(detail)
      throw new GithubError(`gh n'est pas authentifié pour « ${user} » : ${detail || 'gh auth login requis'}`)
    }
    this.token = { user, value }
    return value
  }
}

function mapCi(rollup: { status?: string; conclusion?: string }[] | null | undefined): PrCi {
  const checks = rollup ?? []
  return checks.length === 0 ? null
    : checks.some((c) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR') ? 'failed'
    : checks.some((c) => c.status !== 'COMPLETED') ? 'pending'
    : 'passed'
}

function mapPr(raw: RawPr): PrSummary {
  const state: PrState =
    raw.isDraft === true && raw.state === 'OPEN' ? 'draft'
    : raw.state === 'MERGED' ? 'merged'
    : raw.state === 'CLOSED' ? 'closed'
    : 'open'
  const ci = mapCi(raw.statusCheckRollup)
  const review: PrReview =
    raw.reviewDecision === 'APPROVED' ? 'approved'
    : raw.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested'
    : raw.reviewDecision === 'REVIEW_REQUIRED' ? 'required'
    : null
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? '?',
    state,
    updatedAt: raw.updatedAt,
    branch: raw.headRefName ?? '',
    ci,
    review,
  }
}
