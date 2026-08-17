import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from './cli-args'

/** Aucun token nulle part : le cas qui faisait planter `bun run dev:server` (issue #1). */
const noEnv: Record<string, string | undefined> = {}

describe('parseArgs', () => {
  test('lit le token depuis --token', () => {
    expect(parseArgs(['--token', 'abc'], noEnv).token).toBe('abc')
  })

  test('retombe sur ATELIER_TOKEN quand --token est absent', () => {
    expect(parseArgs([], { ATELIER_TOKEN: 'from-env' }).token).toBe('from-env')
  })

  test('--token gagne sur ATELIER_TOKEN', () => {
    expect(parseArgs(['--token', 'from-arg'], { ATELIER_TOKEN: 'from-env' }).token).toBe('from-arg')
  })

  test('ignore un ATELIER_TOKEN vide', () => {
    expect(() => parseArgs([], { ATELIER_TOKEN: '' })).toThrow(/ATELIER_TOKEN/)
  })

  test('échoue avec un message actionnable quand aucun token n’est fourni', () => {
    expect(() => parseArgs([], noEnv)).toThrow(/--token/)
  })

  test('port par défaut 4517, surchargeable par --port', () => {
    expect(parseArgs(['--token', 't'], noEnv).port).toBe(4517)
    expect(parseArgs(['--token', 't', '--port', '5000'], noEnv).port).toBe(5000)
  })

  test('data path par défaut ~/.atelier/app-data.json', () => {
    expect(parseArgs(['--token', 't'], noEnv).dataPath).toBe(join(homedir(), '.atelier', 'app-data.json'))
  })

  test('--data développe le ~ en home', () => {
    expect(parseArgs(['--token', 't', '--data', '~/tmp/d.json'], noEnv).dataPath).toBe(join(homedir(), 'tmp', 'd.json'))
  })

  test('--data absolu est pris tel quel', () => {
    expect(parseArgs(['--token', 't', '--data', '/var/tmp/d.json'], noEnv).dataPath).toBe('/var/tmp/d.json')
  })

  test('--web-dist et --watch-stdin', () => {
    const parsed = parseArgs(['--token', 't', '--web-dist', '/dist', '--watch-stdin'], noEnv)
    expect(parsed.webDist).toBe('/dist')
    expect(parsed.watchStdin).toBe(true)
  })

  test('watchStdin faux et webDist absent par défaut', () => {
    const parsed = parseArgs(['--token', 't'], noEnv)
    expect(parsed.watchStdin).toBe(false)
    expect(parsed.webDist).toBeUndefined()
  })
})
