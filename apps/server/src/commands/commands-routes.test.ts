import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockSdkClient } from '../sdk/sdk-client.mock'
import { AppData } from '../store/app-data'
import { commandsRoutes } from './commands-routes'

const CMD = { name: 'review', description: 'Relire', argumentHint: '<file>', aliases: [] }

/** AppData réel sur un tmpdir jetable (même motif que freshApp, app.test.ts:20-22). */
function freshRoutes(sdk: MockSdkClient = new MockSdkClient(), withProject = true) {
  const data = new AppData(join(mkdtempSync(join(tmpdir(), 'atelier-cmds-')), 'data.json'))
  if (withProject) data.update((d) => { d.projects.push({ id: 'p1', path: '/tmp/p1', color: '#ffffff' }) })
  return { app: commandsRoutes(data, sdk), data }
}

describe('GET /projects/:id/commands', () => {
  test('renvoie la liste pour un projet connu, sondé sur son path', async () => {
    const sdk = new MockSdkClient({ commands: [CMD] })
    const { app } = freshRoutes(sdk)
    const res = await app.request('/projects/p1/commands')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([CMD])
    expect(sdk.calls).toContainEqual({ method: 'listCommands', args: ['/tmp/p1'] })
  })

  test('404 sur projet inconnu', async () => {
    const { app } = freshRoutes(new MockSdkClient(), false)
    expect((await app.request('/projects/nope/commands')).status).toBe(404)
  })

  test('200 avec [] quand la sonde jette', async () => {
    const sdk = new MockSdkClient()
    sdk.listCommands = async () => { throw new Error('boom') }
    const { app } = freshRoutes(sdk)
    const res = await app.request('/projects/p1/commands')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})
