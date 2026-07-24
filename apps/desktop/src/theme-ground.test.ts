import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GROUND_DARK, GROUND_LIGHT, readThemeGround } from './theme-ground'

describe('readThemeGround', () => {
  test('theme light persisté → fond light', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-'))
    const file = join(dir, 'app-data.json')
    writeFileSync(file, JSON.stringify({ preferences: { theme: 'light' } }))
    expect(readThemeGround(file)).toBe(GROUND_LIGHT)
  })

  test('fichier absent, JSON invalide ou theme absent → fond dark', () => {
    expect(readThemeGround('/nonexistent/app-data.json')).toBe(GROUND_DARK)
    const dir = mkdtempSync(join(tmpdir(), 'atelier-'))
    const bad = join(dir, 'app-data.json')
    writeFileSync(bad, '{oops')
    expect(readThemeGround(bad)).toBe(GROUND_DARK)
  })
})
