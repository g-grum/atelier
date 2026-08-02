import { describe, expect, test } from 'bun:test'
import { MockSdkClient } from './sdk-client.mock'

describe('MockSdkClient.listCommands', () => {
  test('renvoie les commandes scénarisées et enregistre l’appel', async () => {
    const mock = new MockSdkClient({ commands: [{ name: 'review', description: 'r', argumentHint: '', aliases: [] }] })
    expect(await mock.listCommands('/tmp/p')).toEqual([{ name: 'review', description: 'r', argumentHint: '', aliases: [] }])
    expect(mock.calls).toContainEqual({ method: 'listCommands', args: ['/tmp/p'] })
  })

  test('renvoie [] par défaut', async () => {
    expect(await new MockSdkClient().listCommands('/tmp/p')).toEqual([])
  })
})
