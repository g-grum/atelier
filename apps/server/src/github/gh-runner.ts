/** Subprocess seam — the service never spawns directly (tests inject a fake). */
export type GhRun = (args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string; exitCode: number }>

const TIMEOUT_MS = 10_000

/**
 * Real runner. gh path: PATH lookup with a Homebrew fallback — a Dock launch
 * gets a minimal PATH (same constraint as bunPath in the desktop shell).
 */
export function createGhRunner(ghPath: string = Bun.which('gh') ?? '/opt/homebrew/bin/gh'): GhRun {
  return async (args, env) => {
    // Annotation matters: ReturnType<typeof Bun.spawn> widens stdout/stderr to
    // `number | ReadableStream | undefined` and new Response(proc.stdout) fails
    // tsc (TS2345). The explicit generic matches the 'pipe' options below.
    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    try {
      proc = Bun.spawn([ghPath, ...args], {
        env: { ...process.env, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch {
      return { stdout: '', stderr: `gh introuvable (${ghPath}) — installe GitHub CLI : brew install gh`, exitCode: 127 }
    }
    // Timeout tracked with a LOCAL flag: proc.exited is Promise<number> in
    // bun-types (never null — do not compare to null, tsc flags it TS2367).
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
      if (timedOut) {
        return { stdout, stderr: stderr.trim() || 'gh a dépassé le délai de 10 s', exitCode: exitCode === 0 ? 124 : exitCode }
      }
      return { stdout, stderr, exitCode }
    } finally {
      clearTimeout(timeout)
    }
  }
}
