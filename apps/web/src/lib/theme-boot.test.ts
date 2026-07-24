import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { THEME_STORAGE_KEY } from './theme'

describe('anti-flash boot script', () => {
  const html = readFileSync(join(import.meta.dir, '..', '..', 'index.html'), 'utf8')

  test('index.html embarque le script inline avec la clé du cache', () => {
    expect(html).toContain(THEME_STORAGE_KEY)
    expect(html).toContain('data-theme')
  })

  test('le script est placé avant le module main.tsx (pas de flash)', () => {
    expect(html.indexOf(THEME_STORAGE_KEY)).toBeLessThan(html.indexOf('/src/main.tsx'))
  })
})
