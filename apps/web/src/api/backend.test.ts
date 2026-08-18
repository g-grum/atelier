import { describe, expect, test } from 'bun:test'
import type { StatusHubEvent } from '@atelier/shared'
import { backend, createFixtureBackend } from './backend'
import { fixtureDevServers } from '@/mocks/fixtures'
import { defaultApi as modelSelectorApi } from '@/features/settings/components/model-selector/ModelSelector'
import { defaultApi as settingsApi } from '@/features/settings/components/settings-panel/SettingsPanel'

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

describe('fixture backend — artifacts + dev servers (status hub replay)', () => {
  test('createStatusSocket replays artifacts_status and dev_servers_status with the demo data', async () => {
    const fixture = createFixtureBackend()
    const events: StatusHubEvent[] = []
    const socket = fixture.createStatusSocket((event) => events.push(event))
    await new Promise((r) => setTimeout(r, 10))
    socket.close()
    const artifacts = events.find((e) => e.type === 'artifacts_status')
    expect(artifacts?.type).toBe('artifacts_status')
    expect(artifacts !== undefined && artifacts.type === 'artifacts_status' ? artifacts.artifacts.length : 0).toBe(3)
    const servers = events.find((e) => e.type === 'dev_servers_status')
    expect(servers !== undefined && servers.type === 'dev_servers_status' ? servers.servers.map((s) => s.killable) : []).toEqual([true, false])
  })

  test('stopDevServer removes the server from the next hub replay', async () => {
    const fixture = createFixtureBackend()
    const before: StatusHubEvent[] = []
    fixture.createStatusSocket((event) => before.push(event)).close()
    const first = fixtureDevServers[0]!
    await fixture.stopDevServer(first.pid)
    const events: StatusHubEvent[] = []
    const socket = fixture.createStatusSocket((event) => events.push(event))
    await new Promise((r) => setTimeout(r, 10))
    socket.close()
    const servers = events.find((e) => e.type === 'dev_servers_status')
    expect(servers !== undefined && servers.type === 'dev_servers_status' ? servers.servers.map((s) => s.pid) : []).not.toContain(first.pid)
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
