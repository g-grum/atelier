import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Image extensions the artifacts tracker cares about (spec 2026-08-14). */
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp)$/i

/**
 * Extracts candidate image paths from a tool_use input — the same raw
 * { toolName, input } pair describe-tool-use.ts consumes. Pure: no fs access;
 * existence under the project root is the caller's job.
 */
export function extractImagePaths(toolName: string, toolInput: unknown): string[] {
  const record = asRecord(toolInput)
  if (toolName === 'Write' || toolName === 'Edit') {
    const file = record.file_path
    return typeof file === 'string' && IMAGE_RE.test(file) ? [file] : []
  }
  if (toolName === 'Bash') {
    const command = record.command
    if (typeof command !== 'string') return []
    return extractFromCommand(command)
  }
  return []
}

/**
 * Tokenizes a shell command and keeps tokens ending in an image extension.
 * Quoted segments ("a b.png") are treated as single tokens; trailing shell
 * punctuation is stripped so `open x.png;` still matches.
 */
function extractFromCommand(command: string): string[] {
  const out: string[] = []
  // Quoted segments first — they may contain spaces the whitespace split would break.
  const rest = command.replace(/"([^"]*)"|'([^']*)'/g, (_m, dq: string | undefined, sq: string | undefined) => {
    const inner = dq ?? sq ?? ''
    if (IMAGE_RE.test(inner)) out.push(inner)
    return ' '
  })
  for (const raw of rest.split(/\s+/)) {
    const token = raw.replace(/[;,)\]}]+$/, '')
    if (token !== '' && IMAGE_RE.test(token) && !out.includes(token)) out.push(token)
  }
  return out
}

/**
 * Resolves a tool-reported path against the project root and returns the
 * root-relative form — or null when the path escapes the root (anti-traversal:
 * `..` is resolved before the containment check, exact-prefix + separator so a
 * sibling like /project-evil never passes for root /proj).
 */
export function normalizeToProject(root: string, path: string): string | null {
  if (path.includes('\u0000')) return null
  const rootAbs = resolve(root)
  const abs = isAbsolute(path) ? resolve(path) : resolve(rootAbs, path)
  if (abs === rootAbs || !abs.startsWith(rootAbs + sep)) return null
  const rel = relative(rootAbs, abs)
  if (rel === '' || rel.startsWith('..')) return null
  return rel.split(sep).join('/')
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
}
