/**
 * Espace de travail d'un item autopilot : worktree git isolé + dépendances
 * installées (spec 2026-08-05). Runner d'exécution DÉDIÉ (le GitRun partagé de
 * git-remote a un timeout 5 s — bien trop court pour worktree add + bun install).
 */

type ExecResult = { stdout: string; stderr: string; exitCode: number }
export type Exec = (cmd: string[], cwd: string) => Promise<ExecResult>

export type Workspace = {
  /** Crée `.worktrees/autopilot-<n>` sur la branche `autopilot/<n>` puis y lance `bun install` (un worktree vierge n'a pas de node_modules). */
  prepare: (issue: number) => Promise<{ path: string; branch: string }>
  /** `worktree remove --force`, `branch -D` puis suppression du fichier de verdict — chaque échec est non-fatal (nettoyage best-effort). */
  cleanup: (issue: number) => Promise<void>
}

/** Le repoRoot n'est connu qu'au start (path du projet ciblé) — les consommateurs reçoivent la factory, jamais un singleton. */
export type WorkspaceFactory = (repoRoot: string) => Workspace

const EXEC_TIMEOUT_MS = 600_000

const defaultExec: Exec = async (cmd, cwd) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => proc.kill(), EXEC_TIMEOUT_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timeout)
  }
}

export function createWorkspace(repoRoot: string, exec: Exec = defaultExec): Workspace {
  const worktreeRel = (issue: number) => `.worktrees/autopilot-${issue}`
  const branchOf = (issue: number) => `autopilot/${issue}`

  return {
    async prepare(issue) {
      const rel = worktreeRel(issue)
      const branch = branchOf(issue)
      const add = await exec(['git', 'worktree', 'add', rel, '-b', branch], repoRoot)
      if (add.exitCode !== 0) {
        throw new Error(`création du worktree impossible : ${add.stderr.trim() || 'erreur git inconnue'}`)
      }
      const path = `${repoRoot}/${rel}`
      // process.execPath = le binaire bun qui exécute CE serveur — chemin absolu
      // garanti, immune au PATH minimal de launchd (leçon package:mac).
      const install = await exec([process.execPath, 'install'], path)
      if (install.exitCode !== 0) {
        throw new Error(`installation des dépendances impossible : ${install.stderr.trim() || 'erreur bun inconnue'}`)
      }
      return { path, branch }
    },

    async cleanup(issue) {
      const remove = await exec(['git', 'worktree', 'remove', '--force', worktreeRel(issue)], repoRoot)
      if (remove.exitCode !== 0) {
        console.error(`[autopilot] worktree remove a échoué (ignoré) : ${remove.stderr.trim()}`)
      }
      const branch = await exec(['git', 'branch', '-D', branchOf(issue)], repoRoot)
      if (branch.exitCode !== 0) {
        console.error(`[autopilot] branch -D a échoué (ignoré) : ${branch.stderr.trim()}`)
      }
      // Fichier de verdict de review (spec 2026-08-07) — `rm -f` ne râle pas sur
      // un fichier absent, donc pas de log d'échec ici.
      await exec(['rm', '-f', `.worktrees/review-${issue}.json`], repoRoot)
    },
  }
}
