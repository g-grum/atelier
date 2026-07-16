import { join } from 'node:path'

// Where the compiled main finds its repo + bun executable.
//
// Packaged mode (Atelier.app): scripts/package-mac.ts writes a runtime.json
// next to the compiled main with the absolute repo root and bun path captured
// at package time — a Dock launch gets a minimal PATH, so 'bun' would not
// resolve there. Dev mode (no runtime.json): the repo root is three levels up
// from apps/desktop/dist and 'bun' comes from the shell PATH.

export type RuntimeIo = {
  /** Returns the file's text, or null when it is missing/unreadable. */
  readTextFile: (path: string) => string | null
  isDirectory: (path: string) => boolean
}

export type RuntimeResolution =
  | { mode: 'packaged'; repoRoot: string; bunPath: string }
  | { mode: 'dev'; repoRoot: string; bunPath: string }
  | { mode: 'error'; message: string }

export function resolveRuntime(mainDir: string, io: RuntimeIo): RuntimeResolution {
  // mainDir is <desktop package root>/dist — the config sits at the package
  // root (Contents/Resources/app/runtime.json inside the bundle).
  const raw = io.readTextFile(join(mainDir, '..', 'runtime.json'))
  if (raw !== null) {
    const config = parseConfig(raw)
    if (config !== null) {
      if (!io.isDirectory(config.repoRoot)) {
        return {
          mode: 'error',
          message:
            `the Atelier repo recorded at package time no longer exists: ${config.repoRoot}. ` +
            'Run `bun run package:mac` from the repo to rebuild the app bundle.',
        }
      }
      return { mode: 'packaged', repoRoot: config.repoRoot, bunPath: config.bunPath }
    }
  }
  // Absent or malformed runtime.json → dev layout: apps/desktop/dist/main.js.
  return { mode: 'dev', repoRoot: join(mainDir, '..', '..', '..'), bunPath: 'bun' }
}

function parseConfig(raw: string): { repoRoot: string; bunPath: string } | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { repoRoot, bunPath } = parsed as Record<string, unknown>
    if (typeof repoRoot !== 'string' || repoRoot === '') return null
    if (typeof bunPath !== 'string' || bunPath === '') return null
    return { repoRoot, bunPath }
  } catch {
    return null
  }
}
