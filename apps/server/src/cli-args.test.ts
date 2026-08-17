import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from './cli-args'

/** No token anywhere: the case that made `bun run dev:server` crash (issue #1). */
const noEnv: Record<string, string | undefined> = {}

describe('parseArgs', () => {
  test('reads the token from --token', () => {
    expect(parseArgs(['--token', 'abc'], noEnv).token).toBe('abc')
  })

  test('falls back to ATELIER_TOKEN when --token is absent', () => {
    expect(parseArgs([], { ATELIER_TOKEN: 'from-env' }).token).toBe('from-env')
  })

  test('--token wins over ATELIER_TOKEN', () => {
    expect(parseArgs(['--token', 'from-arg'], { ATELIER_TOKEN: 'from-env' }).token).toBe('from-arg')
  })

  test('ignores an empty ATELIER_TOKEN', () => {
    expect(() => parseArgs([], { ATELIER_TOKEN: '' })).toThrow(/ATELIER_TOKEN/)
  })

  test('fails with an actionable message when no token is provided', () => {
    expect(() => parseArgs([], noEnv)).toThrow(/--token/)
  })

  test('port defaults to 4517 and is overridable by --port', () => {
    expect(parseArgs(['--token', 't'], noEnv).port).toBe(4517)
    expect(parseArgs(['--token', 't', '--port', '5000'], noEnv).port).toBe(5000)
  })

  test('data path defaults to ~/.atelier/app-data.json', () => {
    expect(parseArgs(['--token', 't'], noEnv).dataPath).toBe(join(homedir(), '.atelier', 'app-data.json'))
  })

  test('--data expands a leading ~ to the home directory', () => {
    expect(parseArgs(['--token', 't', '--data', '~/tmp/d.json'], noEnv).dataPath).toBe(join(homedir(), 'tmp', 'd.json'))
  })

  test('--data takes an absolute path as-is', () => {
    expect(parseArgs(['--token', 't', '--data', '/var/tmp/d.json'], noEnv).dataPath).toBe('/var/tmp/d.json')
  })

  test('--web-dist and --watch-stdin', () => {
    const parsed = parseArgs(['--token', 't', '--web-dist', '/dist', '--watch-stdin'], noEnv)
    expect(parsed.webDist).toBe('/dist')
    expect(parsed.watchStdin).toBe(true)
  })

  test('watchStdin is false and webDist absent by default', () => {
    const parsed = parseArgs(['--token', 't'], noEnv)
    expect(parsed.watchStdin).toBe(false)
    expect(parsed.webDist).toBeUndefined()
  })
})
