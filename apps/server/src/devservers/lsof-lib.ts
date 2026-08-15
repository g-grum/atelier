/** Pure parsing/labeling helpers for the dev-servers monitor (spec 2026-08-14). No exec here — callers inject raw command output. */

export type ListenEntry = { port: number; pid: number; command: string }
export type PsPair = { pid: number; ppid: number }

/**
 * Parses `lsof -nP -iTCP -sTCP:LISTEN` output. The pid is the FIRST numeric
 * token (command names may contain spaces); the port is the digits right
 * before ` (LISTEN)`. IPv4/IPv6 double listings of the same pid+port collapse.
 */
export function parseLsofListen(output: string): ListenEntry[] {
  const out: ListenEntry[] = []
  const seen = new Set<string>()
  for (const line of output.split('\n')) {
    if (!line.includes('(LISTEN)')) continue
    const portMatch = line.match(/[:.](\d+)\s+\(LISTEN\)/)
    if (portMatch === null) continue
    const tokens = line.trim().split(/\s+/)
    const pidIndex = tokens.findIndex((t) => /^\d+$/.test(t))
    if (pidIndex <= 0) continue
    const pid = Number(tokens[pidIndex])
    const command = tokens.slice(0, pidIndex).join(' ')
    const port = Number(portMatch[1])
    const key = `${pid}:${port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ port, pid, command })
  }
  return out
}

/** Generic runtimes whose process name says nothing about WHAT is served — only those get the bash-command heuristic. */
const RUNTIMES = new Set(['node', 'bun', 'deno', 'npm', 'npx', 'bunx', 'pnpm', 'yarn'])

const LABEL_RULES: readonly { re: RegExp; label: string }[] = [
  { re: /\bvite\b/, label: 'vite' },
  { re: /\bnext(\s+dev)?\b/, label: 'next' },
  { re: /\bbun\s+(run\s+)?dev\b/, label: 'bun dev' },
  { re: /\bastro\b/, label: 'astro' },
  { re: /\bwebpack\b/, label: 'webpack' },
  { re: /\bstorybook\b/, label: 'storybook' },
]

/**
 * Short human label for a listening process. Specific process names win as-is;
 * generic runtimes are labeled from the most recent matching bash command.
 */
export function labelFor(command: string, recentBashCommands: readonly string[]): string {
  if (!RUNTIMES.has(command)) return command
  for (let i = recentBashCommands.length - 1; i >= 0; i--) {
    const bash = recentBashCommands[i]
    if (bash === undefined) continue
    for (const { re, label } of LABEL_RULES) {
      if (re.test(bash)) return label
    }
  }
  return command
}

/** Parses `ps -axo pid,ppid` output into pairs, skipping the header. */
export function parsePsPairs(output: string): PsPair[] {
  const out: PsPair[] = []
  for (const line of output.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (m !== null) out.push({ pid: Number(m[1]), ppid: Number(m[2]) })
  }
  return out
}

/**
 * True when `pid` sits strictly BELOW one of `ancestorPids` in the process
 * tree — a process is never its own descendant, and the walk is cycle-safe.
 */
export function isDescendant(pid: number, ancestorPids: readonly number[], tree: readonly PsPair[]): boolean {
  const parentOf = new Map(tree.map((p) => [p.pid, p.ppid]))
  const ancestors = new Set(ancestorPids)
  const visited = new Set<number>()
  let current = parentOf.get(pid)
  while (current !== undefined && current !== 0 && !visited.has(current)) {
    if (ancestors.has(current)) return true
    visited.add(current)
    current = parentOf.get(current)
  }
  return false
}
