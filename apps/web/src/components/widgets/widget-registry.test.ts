import { describe, expect, test } from 'bun:test'
import { WIDGET_META } from './widget-registry'

describe('WIDGET_META', () => {
  test('github-prs naît sans repo (config à faire) — pas de repo codé en dur', () => {
    const instance = WIDGET_META['github-prs']!.create()
    expect(instance.config).toEqual({ repo: '', limit: 10 })
  })
})
