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

function mapPr(raw: RawPr): PrSummary {
  const state: PrState =
    raw.isDraft === true && raw.state === 'OPEN' ? 'draft'
    : raw.state === 'MERGED' ? 'merged'
    : raw.state === 'CLOSED' ? 'closed'
    : 'open'
  const rollup = raw.statusCheckRollup ?? []
  const ci: PrCi =
    rollup.length === 0 ? null
    : rollup.some((c) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR') ? 'failed'
    : rollup.some((c) => c.status !== 'COMPLETED') ? 'pending'
    : 'passed'
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
