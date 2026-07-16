import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parsePort, resolveRuntime, type RuntimeIo } from './resolve-runtime'

const MAIN_DIR = '/Applications/Atelier.app/Contents/Resources/app/dist'
const DEV_MAIN_DIR = '/repo/apps/desktop/dist'

function io(overrides: Partial<RuntimeIo> = {}): RuntimeIo {
  return {
    readTextFile: () => null,
    isDirectory: () => true,
    isFile: () => true,
    ...overrides,
  }
}

describe('parsePort', () => {
  test('accepts a valid override', () => {
    expect(parsePort('4527', 4517)).toBe(4527)
  })

  test('falls back to the default on garbage or absent values', () => {
    expect(parsePort('garbage', 4517)).toBe(4517)
    expect(parsePort('0', 4517)).toBe(4517)
    expect(parsePort('70000', 4517)).toBe(4517)
    expect(parsePort('45.17', 4517)).toBe(4517)
    expect(parsePort(undefined, 4517)).toBe(4517)
  })
})

describe('resolveRuntime', () => {
  test('uses runtime.json next to the compiled main when present (packaged mode)', () => {
    const config = JSON.stringify({ repoRoot: '/Users/g/atelier', bunPath: '/Users/g/.bun/bin/bun' })
    const reads: string[] = []
    const result = resolveRuntime(
      MAIN_DIR,
      io({
        readTextFile: (path) => {
          reads.push(path)
          return config
        },
      })
    )
    expect(result).toEqual({ mode: 'packaged', repoRoot: '/Users/g/atelier', bunPath: '/Users/g/.bun/bin/bun' })
    // The config lives at the desktop package root (Contents/Resources/app in
    // the bundle), one level above the compiled main's dist/ directory.
    expect(reads).toEqual(['/Applications/Atelier.app/Contents/Resources/app/runtime.json'])
  })

  test('falls back to dev mode (relative root, plain bun) when runtime.json is absent', () => {
    const result = resolveRuntime(DEV_MAIN_DIR, io())
    expect(result).toEqual({ mode: 'dev', repoRoot: join(DEV_MAIN_DIR, '..', '..', '..'), bunPath: 'bun' })
  })

  test('falls back to dev mode when runtime.json is invalid JSON', () => {
    const result = resolveRuntime(DEV_MAIN_DIR, io({ readTextFile: () => '{not json' }))
    expect(result.mode).toBe('dev')
  })

  test('falls back to dev mode when runtime.json lacks the expected fields', () => {
    const result = resolveRuntime(DEV_MAIN_DIR, io({ readTextFile: () => JSON.stringify({ repoRoot: 42 }) }))
    expect(result.mode).toBe('dev')
  })

  test('signals an error when the configured bun binary no longer exists', () => {
    const config = JSON.stringify({ repoRoot: '/Users/g/atelier', bunPath: '/gone/bin/bun' })
    const result = resolveRuntime(
      MAIN_DIR,
      io({ readTextFile: () => config, isFile: (path) => path !== '/gone/bin/bun' })
    )
    expect(result.mode).toBe('error')
    if (result.mode === 'error') {
      expect(result.message).toContain('/gone/bin/bun')
      expect(result.message).toContain('package:mac')
    }
  })

  test('signals an error when the configured repoRoot no longer exists', () => {
    const config = JSON.stringify({ repoRoot: '/gone/atelier', bunPath: '/usr/local/bin/bun' })
    const result = resolveRuntime(
      MAIN_DIR,
      io({ readTextFile: () => config, isDirectory: (path) => path !== '/gone/atelier' })
    )
    expect(result.mode).toBe('error')
    if (result.mode === 'error') {
      expect(result.message).toContain('/gone/atelier')
      expect(result.message).toContain('package:mac')
    }
  })
})
