import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from './app-data'

function freshStore() {
  return new AppData(join(mkdtempSync(join(tmpdir(), 'atelier-')), 'data.json'))
}

describe('AppData', () => {
  test('starts empty and persists a project across instances', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'atelier-')), 'data.json')
    const a = new AppData(path)
    expect(a.get().projects).toEqual([])
    a.update((d) => { d.projects.push({ id: 'p1', path: '/tmp/x', color: 'cyan' }) })
    const b = new AppData(path)
    expect(b.get().projects[0]?.id).toBe('p1')
  })

  test('records usage events (4 counters) and prunes beyond 7 days', () => {
    const store = freshStore()
    const now = Date.now()
    const counters = { inputTokens: 5, outputTokens: 3, cacheReadTokens: 100, cacheCreationTokens: 0 }
    store.recordUsage({ at: new Date(now - 8 * 86400_000).toISOString(), ...counters })
    store.recordUsage({ at: new Date(now).toISOString(), ...counters })
    expect(store.get().usageEvents).toHaveLength(1)
    expect(store.get().usageEvents[0]?.cacheReadTokens).toBe(100)
  })

  test('draft mapping: transfers model, returns deferred name, survives reload', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'atelier-')), 'data.json')
    const store = new AppData(path)
    store.update((d) => { d.drafts.push({ id: 'draft1', projectId: 'p1', name: 'test', model: 'claude-opus-4-8', createdAt: 'now' }) })
    expect(store.mapDraft('draft1', 'sdk-42')).toEqual({ deferredName: 'test' })
    expect(store.resolveSessionId('draft1')).toBe('sdk-42')
    expect(store.get().modelOverrides['sdk-42']).toBe('claude-opus-4-8')
    expect(store.get().drafts).toHaveLength(0)
    const reloaded = new AppData(path)
    expect(reloaded.resolveSessionId('draft1')).toBe('sdk-42')
  })
})
