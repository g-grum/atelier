/** Subprocess seam — the resolver never spawns directly (tests inject a fake). */
export type GitRun = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>

/** The GitHub account a project pushes as, plus its owner/repo — both derived from the origin remote. */
export type GithubRemote = { account: string; repo: string }

const TIMEOUT_MS = 5_000

/**
 * Derive the GitHub account and owner/repo from a git remote URL.
 *
 * - SSH host alias `github.com-<account>` (a per-account ~/.ssh/config entry) →
 *   the account IS the alias suffix; that alias selects the identity you push as.
 * - Otherwise (plain SSH / HTTPS) there is no identity hint in the URL, so the
 *   repo owner is the best available guess.
 *
 * Returns null for anything that is not a github.com remote.
 */
export function parseGithubRemote(url: string): GithubRemote | null {
  const trimmed = url.trim()
  if (trimmed === '') return null

  let host: string
  let path: string
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed)
  if (!trimmed.includes('://') && scp !== null) {
    host = scp[1]!
    path = scp[2]!
  } else {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    host = parsed.hostname
    path = parsed.pathname.replace(/^\//, '')
  }

  const alias = /^github\.com-(.+)$/.exec(host)
  if (host !== 'github.com' && alias === null) return null

  const segments = path.replace(/\.git$/, '').split('/').filter((s) => s !== '')
  if (segments.length < 2) return null
  const owner = segments[0]!
  const repo = `${owner}/${segments[1]!}`
  return { account: alias !== null ? alias[1]! : owner, repo }
}

/** Read a project's `origin` remote and derive its GitHub account — null when there is no GitHub origin. */
export async function projectGithubAccount(run: GitRun, path: string): Promise<GithubRemote | null> {
  const result = await run(['remote', 'get-url', 'origin'], path)
  if (result.exitCode !== 0) return null
  return parseGithubRemote(result.stdout)
}

/**
 * Real runner. git path: PATH lookup with a Homebrew/Xcode fallback — a Dock
 * launch gets a minimal PATH (same constraint as gh-runner / the desktop shell).
 */
export function createGitRunner(gitPath: string = Bun.which('git') ?? '/usr/bin/git'): GitRun {
  return async (args, cwd) => {
    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    try {
      proc = Bun.spawn([gitPath, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    } catch {
      return { stdout: '', stderr: `git introuvable (${gitPath})`, exitCode: 127 }
    }
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, TIMEOUT_MS)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (timedOut) return { stdout, stderr: stderr.trim() || 'git a dépassé le délai', exitCode: exitCode === 0 ? 124 : exitCode }
      return { stdout, stderr, exitCode }
    } finally {
      clearTimeout(timeout)
    }
  }
}
