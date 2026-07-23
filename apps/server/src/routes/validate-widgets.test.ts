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
    ['config on a singleton', [ok({ config: { repo: 'o/r' } })], 'config'],
    ['duplicate singleton', [ok(), ok({ id: 'b' })], 'une fois'],
  ] as const)('rejects %s', (_name, value, fragment) => {
    const result = validateWidgets(value)
    if (!('error' in result)) throw new Error('expected an error')
    expect(result.error).toContain(fragment)
  })

  test('multiple github-prs instances are allowed', () => {
    const result = validateWidgets([pr({ id: 'p1' }), pr({ id: 'p2' })])
    expect('error' in result).toBe(false)
  })
})
