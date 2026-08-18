/**
 * Enforces the import rules of docs/project-structure.md.
 *
 * The tsconfig paths stop an aliased cross-domain import from resolving, but
 * nothing stops a relative `../../features/chat`. This checker closes that gap
 * and runs as a test (scripts/check-structure.test.ts).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export type SourceFile = { path: string; text: string }

const ROOT = resolve(import.meta.dir, '..')
const SCANNED = ['apps/web/src', 'apps/server/src', 'apps/desktop', 'packages']
const SKIPPED = new Set(['node_modules', 'dist', 'dist-app', '.git'])
const SOURCE_EXTENSIONS = ['.ts', '.tsx']

/** Every import/export specifier of a file, including dynamic `import('…')`. */
function specifiersOf(text: string): string[] {
  const matches = text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)
  return [...matches].map((match) => match[1] as string)
}

function featureOf(path: string): string | undefined {
  return /^apps\/web\/src\/features\/([^/]+)\//.exec(path)?.[1]
}

/** Resolves a specifier to a repo-relative path, or undefined when it is a bare package import. */
function resolveSpecifier(fromPath: string, specifier: string): string | undefined {
  if (specifier.startsWith('@/')) return `apps/web/src/${specifier.slice(2)}`
  if (!specifier.startsWith('.')) return undefined
  const dir = join(fromPath, '..')
  return relative(ROOT, resolve(ROOT, dir, specifier))
}

export function structureViolations(files: SourceFile[]): string[] {
  const violations: string[] = []

  for (const { path, text } of files) {
    const feature = featureOf(path)
    const isPackage = path.startsWith('packages/')
    const isCore = path.startsWith('packages/core/')

    for (const specifier of specifiersOf(text)) {
      if (isPackage && (specifier.startsWith('@atelier/web') || specifier.startsWith('@atelier/server') || specifier.startsWith('@atelier/desktop'))) {
        violations.push(`${path} imports an app (${specifier}) — packages must never depend on apps`)
        continue
      }
      if (isCore && specifier.startsWith('@atelier/shared')) {
        violations.push(`${path} imports @atelier/shared — core holds no protocol knowledge`)
        continue
      }

      const target = resolveSpecifier(path, specifier)
      if (target === undefined) continue

      const targetFeature = featureOf(target.endsWith('/') ? target : `${target}/`)
      if (feature !== undefined && targetFeature !== undefined && targetFeature !== feature) {
        violations.push(`${path} (features/${feature}) imports features/${targetFeature} — move the shared part up to components/, stores/, api/ or @atelier/core`)
      }
    }
  }

  return violations
}

export function collectSourceFiles(root: string = ROOT): SourceFile[] {
  const files: SourceFile[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIPPED.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        files.push({ path: relative(root, full), text: readFileSync(full, 'utf8') })
      }
    }
  }

  for (const scanned of SCANNED) {
    const full = join(root, scanned)
    try {
      walk(full)
    } catch {
      // A workspace may not exist yet (fresh checkout of a subset) — skip it.
    }
  }

  return files
}
