import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_WIDGETS, type WidgetInstance } from '@atelier/shared'
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

  test('fresh store carries the default usage budgets', () => {
    const store = freshStore()
    expect(store.get().preferences.windowBudgetTokens).toBe(2_000_000)
    expect(store.get().preferences.weeklyBudgetTokens).toBe(12_000_000)
  })

  test('recordRateLimit keeps the LATEST snapshot per window and persists across instances', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'atelier-')), 'data.json')
    const store = new AppData(path)
    store.recordRateLimit({ window: 'five_hour', utilization: 12, status: 'allowed', resetsAt: '2026-07-17T16:00:00.000Z', recordedAt: '2026-07-17T12:00:00.000Z' })
    store.recordRateLimit({ window: 'seven_day', utilization: 40, status: 'allowed', recordedAt: '2026-07-17T12:00:00.000Z' })
    store.recordRateLimit({ window: 'five_hour', utilization: 34, status: 'allowed_warning', resetsAt: '2026-07-17T16:00:00.000Z', recordedAt: '2026-07-17T12:05:00.000Z' })

    const reloaded = new AppData(path)
    expect(reloaded.get().rateLimits['five_hour']?.utilization).toBe(34)
    expect(reloaded.get().rateLimits['five_hour']?.status).toBe('allowed_warning')
    expect(reloaded.get().rateLimits['seven_day']?.utilization).toBe(40)
  })

  test('mapDraft moves the draft permissionMode into permissionModes (loss-less, like model)', () => {
    const store = freshStore()
    store.update((d) => {
      d.drafts.push({ id: 'd1', projectId: 'p1', name: null, model: 'claude-fable-5', createdAt: new Date().toISOString(), permissionMode: 'bypassPermissions' })
    })

    store.mapDraft('d1', 'sdk-1')

    expect(store.get().permissionModes['sdk-1']).toBe('bypassPermissions')
    expect(store.get().drafts).toHaveLength(0)
  })

  test('mapDraft of an undecided draft records no permissionMode entry — the question stays pending', () => {
    const store = freshStore()
    store.update((d) => {
      d.drafts.push({ id: 'd1', projectId: 'p1', name: null, model: 'claude-fable-5', createdAt: new Date().toISOString() })
    })

    store.mapDraft('d1', 'sdk-1')

    expect(store.get().permissionModes['sdk-1']).toBeUndefined()
  })

  test('migrates a v0.1 data file: budget defaults appear without clobbering saved preferences', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'atelier-')), 'data.json')
    // Exact v0.1 on-disk shape: preferences carries ONLY { ide, defaultModel }.
    // A shallow `{ ...EMPTY, ...parsed }` would replace the nested preferences
    // object wholesale and lose the new budget defaults — the constructor must
    // deep-merge `{ ...EMPTY.preferences, ...parsed.preferences }`.
    writeFileSync(path, JSON.stringify({
      projects: [],
      preferences: { ide: 'vscode', defaultModel: 'claude-opus-4-8' },
      drafts: [],
      draftMap: {},
      modelOverrides: {},
      rules: [],
      usageEvents: [],
    }))
    const store = new AppData(path)
    expect(store.get().preferences).toEqual({
      ide: 'vscode',
      defaultModel: 'claude-opus-4-8',
      windowBudgetTokens: 2_000_000,
      weeklyBudgetTokens: 12_000_000,
    })
  })

  test('saved budgets win over the defaults on reload', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'atelier-')), 'data.json')
    const a = new AppData(path)
    a.update((d) => { d.preferences.windowBudgetTokens = 5_000_000 })
    const b = new AppData(path)
    expect(b.get().preferences.windowBudgetTokens).toBe(5_000_000)
    expect(b.get().preferences.weeklyBudgetTokens).toBe(12_000_000)
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

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'atelier-appdata-')), 'data.json')
}

describe('AppData.widgets', () => {
  test('fresh store defaults to DEFAULT_WIDGETS', () => {
    const data = new AppData(tmpFile())
    expect(data.get().widgets).toEqual([...DEFAULT_WIDGETS])
  })

  test('legacy file without the key gets the default (backward compat)', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ projects: [] }))
    const data = new AppData(file)
    expect(data.get().widgets).toEqual([...DEFAULT_WIDGETS])
  })

  test('legacy-file instance mutating IN PLACE never pollutes another instance (clone guard)', () => {
    // Both instances must take the `{ ...EMPTY, ...parsed }` branch (file WITHOUT
    // the key) and the mutation must be in-place — a replaced reference or the
    // fresh-store branch would pass even without the clone guard.
    const legacyA = tmpFile()
    writeFileSync(legacyA, JSON.stringify({ projects: [] }))
    new AppData(legacyA).update((d) => {
      d.widgets.push({ id: 'x', type: 'github-prs', span: 1, height: 'S', config: { repo: 'o/r' } })
    })
    const legacyB = tmpFile()
    writeFileSync(legacyB, JSON.stringify({ projects: [] }))
    expect(new AppData(legacyB).get().widgets).toEqual([...DEFAULT_WIDGETS])
  })

  test('a stored layout round-trips through the file', () => {
    const file = tmpFile()
    const stored: WidgetInstance[] = [{ id: 'w1', type: 'github-prs', span: 1, height: 'S', config: { repo: 'o/r', limit: 5 } }]
    new AppData(file).update((d) => {
      d.widgets = stored
    })
    expect(new AppData(file).get().widgets).toEqual(stored)
  })

  test('an explicitly empty stored layout is preserved, not reset to the default', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ widgets: [] }))
    expect(new AppData(file).get().widgets).toEqual([])
  })
})
