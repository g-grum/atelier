import type { Preferences } from '@atelier/shared'

export type Ide = Preferences['ide']

/** Runs argv and resolves true on exit 0. Injected in tests so nothing spawns. */
export type LaunchFn = (argv: string[]) => Promise<boolean>

export type OpenResult = { ok: true } | { ok: false; reason: string }

const IDES: readonly Ide[] = ['webstorm', 'vscode', 'cursor', 'idea']

/** CLI launcher binary per IDE (JetBrains Toolbox launchers; `code`/`cursor` shell commands). */
const CLI_BIN: Record<Ide, string> = {
  webstorm: 'webstorm',
  idea: 'idea',
  vscode: 'code',
  cursor: 'cursor',
}

const LAUNCHER_FIX: Record<Ide, string> = {
  webstorm: 'installez le launcher webstorm via JetBrains Toolbox',
  idea: 'installez le launcher idea via JetBrains Toolbox',
  vscode: "installez la commande « code » (Shell Command: Install 'code' command)",
  cursor: "installez la commande « cursor » (Shell Command: Install 'cursor' command)",
}

/**
 * Escapes only the characters that are invalid (whitespace) or ambiguous (&, #, %, ?)
 * in the URL path/query-value position — `/` and `:` stay intact. Without this,
 * a space makes `open <url>` fail to parse (dead scheme route → misleading
 * "install the launcher"), and `&`/`#`/`%` yield a dispatchable-but-misparsed URL:
 * `open` exits 0, we report ok, and the IDE opens the wrong file — a silent failure.
 */
function escapePath(file: string): string {
  return file.replace(/[%\s&#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

export function buildSchemeUrl(ide: Ide, file: string, line?: number): string {
  const path = escapePath(file)
  if (ide === 'vscode' || ide === 'cursor') {
    // Canonical form vscode://file/<abs>:<line> — the path's leading slash is the separator.
    return `${ide}://file${path}${line === undefined ? '' : `:${line}`}`
  }
  return `${ide}://open?file=${path}${line === undefined ? '' : `&line=${line}`}`
}

export function buildCliArgs(ide: Ide, file: string, line?: number): string[] {
  const bin = CLI_BIN[ide]
  if (line === undefined) return [bin, file]
  if (ide === 'vscode' || ide === 'cursor') return [bin, '--goto', `${file}:${line}`]
  return [bin, '--line', String(line), file]
}

export const spawnLaunch: LaunchFn = async (argv) => {
  try {
    const proc = Bun.spawn(argv as [string, ...string[]], { stdout: 'ignore', stderr: 'ignore' })
    return (await proc.exited) === 0
  } catch {
    return false // binary missing (ENOENT) — the caller falls through / reports the fix
  }
}

export async function openInIde({ ide, file, line, launch = spawnLaunch }: { ide: string; file: string; line?: number; launch?: LaunchFn }): Promise<OpenResult> {
  if (!(IDES as readonly string[]).includes(ide)) {
    return { ok: false, reason: `IDE inconnu : ${ide} — choisissez webstorm, vscode, cursor ou idea dans les préférences` }
  }
  const known = ide as Ide
  if (await launch(['open', buildSchemeUrl(known, file, line)])) return { ok: true }
  if (await launch(buildCliArgs(known, file, line))) return { ok: true }
  return { ok: false, reason: `Impossible d'ouvrir ${known} — ${LAUNCHER_FIX[known]}` }
}
