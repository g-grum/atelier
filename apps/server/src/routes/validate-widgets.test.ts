import { describe, expect, test } from 'bun:test'
import { validateWidgets } from './validate-widgets'

const ok = (over: object = {}) => ({ id: 'a', type: 'rate-limits', span: 2, height: 'M', ...over })
const pr = (over: object = {}) => ({ id: 'p', type: 'github-prs', span: 2, height: 'M', config: { repo: 'o/r' }, ...over })

describe('validateWidgets', () => {
  test('accepts a valid layout and strips unknown keys', () => {
    const result = validateWidgets([{ ...ok(), rogue: true }, pr({ id: 'p1', config: { repo: 'o/r', limit: 5 } })])
    if ('error' in result) throw new Error(result.error)
    expect(result.widgets).toEqual([
      { id: 'a', type: 'rate-limits', span: 2, height: 'M' },
      { id: 'p1', type: 'github-prs', span: 2, height: 'M', config: { repo: 'o/r', limit: 5 } },
    ])
  })

  test('accepts the empty layout', () => {
    expect(validateWidgets([])).toEqual({ widgets: [] })
  })

  test.each([
    ['not an array', {}, 'tableau'],
    ['non-object entry', [42], 'objet'],
    ['missing id', [ok({ id: undefined })], 'id'],
    ['duplicate id', [ok(), ok()], 'dupliqué'],
    ['unknown type', [ok({ type: 'clock' })], 'type inconnu'],
    ['bad span', [ok({ span: 3 })], 'span'],
    ['bad height', [ok({ height: 'XL' })], 'height'],
    ['github-prs without config', [pr({ config: undefined })], 'config'],
    ['github-prs bad repo', [pr({ config: { repo: 'no-slash' } })], 'repo'],
    ['github-prs bad limit', [pr({ config: { repo: 'o/r', limit: 0 } })], 'limit'],
    ['limit above 30', [pr({ config: { repo: 'o/r', limit: 31 } })], 'limit'],
    ['non-integer limit', [pr({ config: { repo: 'o/r', limit: 1.5 } })], 'limit'],
    ['span as string', [ok({ span: '2' })], 'span'],
    ['config on a singleton', [ok({ config: { repo: 'o/r' } })], 'n’est pas accepté'],
    ['duplicate singleton', [ok(), ok({ id: 'b' })], 'une fois'],
  ] as const)('rejects %s', (_name, value, fragment) => {
    const result = validateWidgets(value)
    if (!('error' in result)) throw new Error('expected an error')
    expect(result.error).toContain(fragment)
  })

  test('github-prs au repo vide accepté (instance fraîche « à configurer »)', () => {
    const result = validateWidgets([pr({ config: { repo: '', limit: 10 } })])
    if ('error' in result) throw new Error(result.error)
    expect(result.widgets).toEqual([{ id: 'p', type: 'github-prs', span: 2, height: 'M', config: { repo: '', limit: 10 } }])
  })

  test('multiple github-prs instances are allowed', () => {
    const result = validateWidgets([pr({ id: 'p1' }), pr({ id: 'p2' })])
    if ('error' in result) throw new Error(result.error)
  })
})

describe('widget autopilot (spec 2026-08-05)', () => {
  const base = { id: 'a1', type: 'autopilot', span: 2, height: 'M' }

  test('accepté avec config { projectId, maxItems }', () => {
    const result = validateWidgets([{ ...base, config: { projectId: 'p1', maxItems: 3 } }])
    expect(result).toEqual({ widgets: [{ id: 'a1', type: 'autopilot', span: 2, height: 'M', config: { projectId: 'p1', maxItems: 3 } }] })
  })

  test('accepté sans maxItems', () => {
    const result = validateWidgets([{ ...base, config: { projectId: 'p1' } }])
    expect(result).toEqual({ widgets: [{ id: 'a1', type: 'autopilot', span: 2, height: 'M', config: { projectId: 'p1' } }] })
  })

  test('config absente refusée (projectId requis)', () => {
    expect(validateWidgets([{ ...base }])).toHaveProperty('error')
  })

  test('maxItems hors bornes refusé', () => {
    expect(validateWidgets([{ ...base, config: { projectId: 'p1', maxItems: 0 } }])).toHaveProperty('error')
    expect(validateWidgets([{ ...base, config: { projectId: 'p1', maxItems: 11 } }])).toHaveProperty('error')
  })

  test('config repo sur un widget autopilot refusée (clés inconnues strippées ou rejet)', () => {
    const result = validateWidgets([{ ...base, config: { projectId: 'p1', repo: 'o/r' } }])
    // le contrat : jamais de repo persisté sur un widget autopilot
    if ('widgets' in result) expect(result.widgets[0]!.config).toEqual({ projectId: 'p1' })
    else expect(result).toHaveProperty('error')
  })

  test('singleton : deux widgets autopilot refusés', () => {
    expect(validateWidgets([
      { ...base, config: { projectId: 'p1' } },
      { ...base, id: 'a2', config: { projectId: 'p1' } },
    ])).toHaveProperty('error')
  })
})
