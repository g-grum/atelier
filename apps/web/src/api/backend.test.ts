import { describe, expect, test } from 'bun:test'
import { backend, createFixtureBackend } from './backend'
import { defaultApi as modelSelectorApi } from '../components/ModelSelector'
import { defaultApi as settingsApi } from '../components/SettingsPanel'

describe('fixture backend — méthodes du seam ajoutées pour Réglages', () => {
  test('listRules → règles démo ; deleteRule les retire', async () => {
    const fixture = createFixtureBackend()
    const rules = await fixture.listRules()
    expect(rules.length).toBeGreaterThan(0)
    await fixture.deleteRule(rules[0]!.id)
    expect((await fixture.listRules()).map((r) => r.id)).not.toContain(rules[0]!.id)
  })

  test('deleteProject retire le projet de listProjects', async () => {
    const fixture = createFixtureBackend()
    const [first] = await fixture.listProjects()
    await fixture.deleteProject(first!.id)
    expect((await fixture.listProjects()).map((p) => p.id)).not.toContain(first!.id)
  })
})

describe('FixtureSocket — tour d’erreur', () => {
  test('user_message contenant « erreur » rejoue fixtureErrorTurn (fin en status error)', async () => {
    const socket = createFixtureBackend().createSocket('s1', 'p1')
    const events: unknown[] = []
    socket.on((event) => events.push(event))
    socket.send({ type: 'user_message', text: 'provoque une erreur pour la démo' })
    await new Promise((r) => setTimeout(r, 900))
    socket.close()
    expect(JSON.stringify(events)).toContain('usage_limit')
  })

  test('user_message ordinaire rejoue le tour nominal (pas d’erreur)', async () => {
    const socket = createFixtureBackend().createSocket('s1', 'p1')
    const events: unknown[] = []
    socket.on((event) => events.push(event))
    socket.send({ type: 'user_message', text: 'bonjour' })
    await new Promise((r) => setTimeout(r, 300))
    socket.close()
    expect(JSON.stringify(events)).not.toContain('usage_limit')
  })
})

describe('unification sur le seam Backend', () => {
  test('ModelSelector et SettingsPanel consomment backend par défaut (pas client direct)', () => {
    expect(modelSelectorApi.patchSession).toBe(backend.patchSession)
    expect(settingsApi.getPreferences).toBe(backend.getPreferences)
    expect(settingsApi.listRules).toBe(backend.listRules)
    expect(settingsApi.deleteProject).toBe(backend.deleteProject)
  })
})
