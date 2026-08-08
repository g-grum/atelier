import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseVerdict, readVerdict } from './review-verdict'

describe('parseVerdict', () => {
  test('approve → verdict approve sans findings', () => {
    expect(parseVerdict('{"verdict":"approve"}')).toEqual({ verdict: 'approve', findings: [] })
  })

  test('request_changes avec findings valides → objet complet', () => {
    const raw = '{"verdict":"request_changes","findings":[{"title":"Bug","detail":"crash sur tableau vide"}]}'
    expect(parseVerdict(raw)).toEqual({
      verdict: 'request_changes',
      findings: [{ title: 'Bug', detail: 'crash sur tableau vide' }],
    })
  })

  test('finding sans detail → detail vide', () => {
    const raw = '{"verdict":"request_changes","findings":[{"title":"Bug"}]}'
    expect(parseVerdict(raw)).toEqual({ verdict: 'request_changes', findings: [{ title: 'Bug', detail: '' }] })
  })

  test('request_changes sans findings → null', () => {
    expect(parseVerdict('{"verdict":"request_changes"}')).toBeNull()
  })

  test('request_changes avec findings vide → null', () => {
    expect(parseVerdict('{"verdict":"request_changes","findings":[]}')).toBeNull()
  })

  test('finding sans title → null', () => {
    expect(parseVerdict('{"verdict":"request_changes","findings":[{"detail":"d"}]}')).toBeNull()
  })

  test('JSON invalide → null', () => {
    expect(parseVerdict('pas du JSON')).toBeNull()
  })

  test('verdict inconnu → null', () => {
    expect(parseVerdict('{"verdict":"comment"}')).toBeNull()
  })

  test('non-objet → null', () => {
    expect(parseVerdict('"approve"')).toBeNull()
    expect(parseVerdict('null')).toBeNull()
  })
})

describe('readVerdict', () => {
  test('fichier absent → null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-'))
    expect(await readVerdict(join(dir, 'absent.json'))).toBeNull()
  })

  test('fichier présent → verdict parsé', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-'))
    const path = join(dir, 'review-7.json')
    await Bun.write(path, '{"verdict":"approve"}')
    expect(await readVerdict(path)).toEqual({ verdict: 'approve', findings: [] })
  })
})
