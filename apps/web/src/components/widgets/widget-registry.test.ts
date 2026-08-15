import { describe, expect, test } from 'bun:test'
import { WIDGET_META } from './widget-registry'

describe('WIDGET_META', () => {
  test('github-prs naît sans repo (config à faire) — pas de repo codé en dur', () => {
    const instance = WIDGET_META['github-prs']!.create()
    expect(instance.config).toEqual({ repo: '', limit: 10 })
  })

  test('session-visuals and dev-servers: singletons, span 1, height M, no config', () => {
    for (const type of ['session-visuals', 'dev-servers'] as const) {
      const meta = WIDGET_META[type]
      expect(meta).not.toBeUndefined()
      expect(meta!.multiInstance).toBe(false)
      const instance = meta!.create()
      expect(instance.type).toBe(type)
      expect(instance.span).toBe(1)
      expect(instance.height).toBe('M')
      expect(instance.config).toBeUndefined()
    }
    expect(WIDGET_META['session-visuals']!.title).toBe('Session visuals')
    expect(WIDGET_META['dev-servers']!.title).toBe('Dev servers')
  })
})
