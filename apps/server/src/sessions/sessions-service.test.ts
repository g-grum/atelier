import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from '../store/app-data'
import type { SdkSessionInfo } from '../sdk/sdk-client'
import { MockSdkClient } from '../sdk/sdk-client.mock'
import { SessionStreamRegistry } from '../stream/session-stream'
import { SessionNotFoundError, SessionsService } from './sessions-service'

type Turns = NonNullable<ConstructorParameters<typeof MockSdkClient>[0]>['turns']

function freshSetup(sessions: SdkSessionInfo[] = [], turns?: Turns) {
  const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-sessions-')), 'data.json')
  const data = new AppData(filePath)
  data.update((d) => {
    d.projects.push({ id: 'p1', path: '/tmp/x', color: 'cyan' })
  })
  const sdk = new MockSdkClient({ sessions, turns })
  const registry = new SessionStreamRegistry(data, sdk)
  const service = new SessionsService(sdk, data, registry)
  return { data, sdk, service, registry }
}

describe('SessionsService', () => {
  test('list merges SDK sessions and drafts, drafts first', async () => {
    const sdkSession = { id: 's1', name: 'SDK session', updatedAt: '2025-01-01T00:00:00.000Z', messageCount: 3 }
    const { service } = freshSetup([sdkSession])

    service.createDraft('p1', { name: 'brouillon' })
    const result = await service.list('p1')

    expect(result).toHaveLength(2)
    expect(result[0]?.isDraft).toBe(true)
    expect(result[0]?.name).toBe('brouillon')
    expect(result[1]?.isDraft).toBe(false)
    expect(result[1]?.id).toBe('s1')
  })

  test('createDraft uses preference model when none given', () => {
    const { service, data } = freshSetup()
    const summary = service.createDraft('p1', {})
    expect(summary.model).toBe(data.get().preferences.defaultModel)
  })

  test('createDraft uses the given model when provided', () => {
    const { service } = freshSetup()
    const summary = service.createDraft('p1', { model: 'claude-opus-4-8' })
    expect(summary.model).toBe('claude-opus-4-8')
  })

  test('rename on a draft is deferred (stored on the draft, NO SdkClient.renameSession call)', async () => {
    const { service, sdk } = freshSetup()
    const draft = service.createDraft('p1', { name: 'old name' })

    await service.rename(draft.id, 'new name')

    const hasRenameCall = sdk.calls.some((c) => c.method === 'renameSession')
    expect(hasRenameCall).toBe(false)

    const result = await service.list('p1')
    expect(result[0]?.name).toBe('new name')
  })

  test('rename on an SDK session calls SdkClient.renameSession with the resolved id', async () => {
    const sdkSession = { id: 's1', name: 'original', updatedAt: '2025-01-01T00:00:00.000Z', messageCount: 1 }
    const { service, sdk } = freshSetup([sdkSession])

    await service.rename('s1', 'renamed')

    const renameCall = sdk.calls.find((c) => c.method === 'renameSession')
    expect(renameCall).toBeDefined()
    expect(renameCall?.args).toEqual(['s1', 'renamed'])
  })

  test('setModel persists an override and list reflects it on the SDK session', async () => {
    const sdkSession = { id: 's1', name: 'session', updatedAt: '2025-01-01T00:00:00.000Z', messageCount: 0 }
    const { service } = freshSetup([sdkSession])

    await service.setModel('s1', 'claude-opus-4-8')
    const result = await service.list('p1')

    const sdkSummary = result.find((s) => s.id === 's1')
    expect(sdkSummary?.model).toBe('claude-opus-4-8')
  })

  test('createDraft returns permissionMode null — the UI must ask before the first turn', () => {
    const { service } = freshSetup()
    const summary = service.createDraft('p1', {})
    expect(summary.permissionMode).toBeNull()
  })

  test('createDraft stamps preferences.defaultPermissionMode — no gate for the new session', async () => {
    const { service, data } = freshSetup()
    data.update((d) => {
      d.preferences.defaultPermissionMode = 'bypassPermissions'
    })

    const summary = service.createDraft('p1', {})

    // Le SessionSummary retourné ET le record stocké portent le mode (cohérence spec).
    expect(summary.permissionMode).toBe('bypassPermissions')
    const result = await service.list('p1')
    expect(result[0]?.permissionMode).toBe('bypassPermissions')
  })

  test('a stamped draft keeps its mode through materialization (mapDraft)', () => {
    const { service, data } = freshSetup()
    data.update((d) => {
      d.preferences.defaultPermissionMode = 'default'
    })
    const draft = service.createDraft('p1', {})

    data.mapDraft(draft.id, 'sdk-1')

    expect(data.get().permissionModes['sdk-1']).toBe('default')
  })

  test('list yields permissionMode null for an SDK session without a recorded choice', async () => {
    const sdkSession = { id: 's1', name: 'session', updatedAt: '2025-01-01T00:00:00.000Z', messageCount: 0 }
    const { service } = freshSetup([sdkSession])
    const result = await service.list('p1')
    expect(result[0]?.permissionMode).toBeNull()
  })

  test('setPermissionMode on a draft persists on the draft and list reflects it', async () => {
    const { service } = freshSetup()
    const draft = service.createDraft('p1', {})

    service.setPermissionMode(draft.id, 'bypassPermissions')
    const result = await service.list('p1')

    expect(result[0]?.permissionMode).toBe('bypassPermissions')
  })

  test('setPermissionMode on an SDK session persists an override and list reflects it', async () => {
    const sdkSession = { id: 's1', name: 'session', updatedAt: '2025-01-01T00:00:00.000Z', messageCount: 0 }
    const { service } = freshSetup([sdkSession])

    service.setPermissionMode('s1', 'default')
    const result = await service.list('p1')

    expect(result.find((s) => s.id === 's1')?.permissionMode).toBe('default')
  })

  test('messages(draftId) returns [] without hitting the SDK', async () => {
    const { service, sdk } = freshSetup()
    const draft = service.createDraft('p1', {})

    const messages = await service.messages(draft.id)

    expect(messages).toEqual([])
    const hasMessagesCall = sdk.calls.some((c) => c.method === 'getSessionMessages')
    expect(hasMessagesCall).toBe(false)
  })

  describe('countSessions', () => {
    test('counts SDK sessions for the project path plus its unsent drafts', async () => {
      const sdkSessions = [
        { id: 's1', name: 'one', updatedAt: '2025-01-01T00:00:00.000Z', messageCount: 2 },
        { id: 's2', name: 'two', updatedAt: '2025-01-02T00:00:00.000Z', messageCount: 5 },
      ]
      const { service } = freshSetup(sdkSessions)
      service.createDraft('p1', { name: 'brouillon' })

      expect(await service.countSessions('p1')).toBe(3)
    })

    test('drafts of OTHER projects are not counted', async () => {
      const { service, data } = freshSetup()
      data.update((d) => {
        d.projects.push({ id: 'p2', path: '/tmp/y', color: 'magenta' })
      })
      service.createDraft('p2', {})

      expect(await service.countSessions('p1')).toBe(0)
    })

    test('a throwing listSessions yields 0 — never a throw, the projects list must render even if one folder is unreadable', async () => {
      const { service, sdk } = freshSetup()
      sdk.listSessions = async () => {
        throw new Error('EACCES: dossier illisible')
      }

      expect(await service.countSessions('p1')).toBe(0)
    })
  })

  describe('delete', () => {
    const sdkSession = { id: 's1', name: 'session', updatedAt: '2025-01-01T00:00:00.000Z', messageCount: 3 }

    test('a draft is removed from the list without touching the SDK', async () => {
      const { service, sdk } = freshSetup()
      const draft = service.createDraft('p1', {})

      await service.delete(draft.id)

      expect((await service.list('p1')).every((s) => s.id !== draft.id)).toBe(true)
      expect(sdk.calls.some((c) => c.method === 'deleteSession')).toBe(false)
    })

    test('an SDK session is deleted with the resolved id and the owning project dir', async () => {
      const { service, sdk } = freshSetup([sdkSession])

      await service.delete('s1')

      expect(sdk.calls).toContainEqual({ method: 'deleteSession', args: ['s1', '/tmp/x'] })
    })

    test('a materialized draft id resolves through draftMap', async () => {
      const { service, sdk, data } = freshSetup([{ ...sdkSession, id: 'sdk-1' }])
      data.update((d) => {
        d.draftMap['d1'] = 'sdk-1'
      })

      await service.delete('d1')

      expect(sdk.calls).toContainEqual({ method: 'deleteSession', args: ['sdk-1', '/tmp/x'] })
    })

    test('AppData cleanup: modelOverrides, permissionModes and draftMap entries go — usageEvents stay', async () => {
      const { service, data } = freshSetup([sdkSession])
      data.update((d) => {
        d.draftMap['d0'] = 's1'
        d.modelOverrides['s1'] = 'claude-opus-4-8'
        d.permissionModes['s1'] = 'bypassPermissions'
        d.usageEvents.push({ at: new Date().toISOString(), inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 })
      })

      await service.delete('s1')

      expect(data.get().modelOverrides['s1']).toBeUndefined()
      expect(data.get().permissionModes['s1']).toBeUndefined()
      expect(data.get().draftMap['d0']).toBeUndefined()
      // consumption history stays meaningful after the conversation is gone (spec)
      expect(data.get().usageEvents).toHaveLength(1)
    })

    test('the live stream is disposed and its turn aborted BEFORE sdk.deleteSession runs', async () => {
      const { service, sdk, registry } = freshSetup([sdkSession], [[
        { type: 'needs_permission', toolName: 'Bash', input: { command: 'sleep 999' } },
        { type: 'turn_done' },
      ]])
      const stream = registry.get('s1', 'p1')
      stream.onMessage(JSON.stringify({ type: 'user_message', text: 'go' }))
      await Bun.sleep(0)
      const params = sdk.calls.find((c) => c.method === 'runTurn')!.args[0] as { signal: AbortSignal }

      // dispose-before-delete: the SDK process must no longer be appending to the
      // JSONL when it is removed — observe the signal AT deleteSession time.
      const abortedAtDelete: boolean[] = []
      const originalDelete = sdk.deleteSession.bind(sdk)
      sdk.deleteSession = async (sessionId, dir) => {
        abortedAtDelete.push(params.signal.aborted)
        await originalDelete(sessionId, dir)
      }

      await service.delete('s1')

      expect(abortedAtDelete).toEqual([true])
    })

    test('a draft whose FIRST turn is in flight has its turn aborted too (no resurrection)', async () => {
      const { service, sdk, registry } = freshSetup([], [[
        { type: 'needs_permission', toolName: 'Bash', input: { command: 'sleep 999' } },
        { type: 'turn_done' },
      ]])
      const draft = service.createDraft('p1', {})
      registry.get(draft.id, 'p1').onMessage(JSON.stringify({ type: 'user_message', text: 'go' }))
      await Bun.sleep(0)

      await service.delete(draft.id)

      const params = sdk.calls.find((c) => c.method === 'runTurn')!.args[0] as { signal: AbortSignal }
      expect(params.signal.aborted).toBe(true)
      expect((await service.list('p1')).every((s) => s.id !== draft.id)).toBe(true)
      expect(sdk.calls.some((c) => c.method === 'deleteSession')).toBe(false)
    })

    test('an unknown id throws SessionNotFoundError', async () => {
      const { service } = freshSetup()
      await expect(service.delete('ghost')).rejects.toBeInstanceOf(SessionNotFoundError)
    })

    test("an SDK 'not found' failure surfaces as SessionNotFoundError", async () => {
      const { service, sdk } = freshSetup([sdkSession])
      sdk.deleteSession = async () => {
        throw new Error('Session s1 not found in any project directory')
      }
      await expect(service.delete('s1')).rejects.toBeInstanceOf(SessionNotFoundError)
    })

    test('an unreadable project folder is skipped, not fatal — the owning scan keeps going', async () => {
      const { service, sdk, data } = freshSetup([sdkSession])
      data.update((d) => {
        d.projects.unshift({ id: 'p0', path: '/tmp/unreadable', color: 'magenta' })
      })
      const original = sdk.listSessions.bind(sdk)
      sdk.listSessions = async (cwd) => {
        if (cwd === '/tmp/unreadable') throw new Error('EACCES: dossier illisible')
        return original(cwd)
      }

      await service.delete('s1')

      expect(sdk.calls).toContainEqual({ method: 'deleteSession', args: ['s1', '/tmp/x'] })
    })

    test("an SDK 'not found' failure still cleans the session's AppData entries (definitively gone)", async () => {
      const { service, sdk, data } = freshSetup([sdkSession])
      data.update((d) => {
        d.modelOverrides['s1'] = 'claude-opus-4-8'
      })
      sdk.deleteSession = async () => {
        throw new Error('Session s1 not found in any project directory')
      }

      await expect(service.delete('s1')).rejects.toBeInstanceOf(SessionNotFoundError)
      expect(data.get().modelOverrides['s1']).toBeUndefined()
    })

    test('a non-not-found SDK failure propagates unchanged and SKIPS the AppData cleanup', async () => {
      const { service, sdk, data } = freshSetup([sdkSession])
      data.update((d) => {
        d.modelOverrides['s1'] = 'claude-opus-4-8'
      })
      sdk.deleteSession = async () => {
        throw new Error('EBUSY: fichier verrouillé')
      }

      await expect(service.delete('s1')).rejects.toThrow('EBUSY: fichier verrouillé')
      // the file may still exist — keep the session's AppData so it stays usable
      expect(data.get().modelOverrides['s1']).toBe('claude-opus-4-8')
    })
  })
})
