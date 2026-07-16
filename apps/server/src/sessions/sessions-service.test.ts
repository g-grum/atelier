import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from '../store/app-data'
import type { SdkSessionInfo } from '../sdk/sdk-client'
import { MockSdkClient } from '../sdk/sdk-client.mock'
import { SessionsService } from './sessions-service'

function freshSetup(sessions: SdkSessionInfo[] = []) {
  const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-sessions-')), 'data.json')
  const data = new AppData(filePath)
  data.update((d) => {
    d.projects.push({ id: 'p1', path: '/tmp/x', color: 'cyan' })
  })
  const sdk = new MockSdkClient({ sessions })
  const service = new SessionsService(sdk, data)
  return { data, sdk, service }
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

  test('messages(draftId) returns [] without hitting the SDK', async () => {
    const { service, sdk } = freshSetup()
    const draft = service.createDraft('p1', {})

    const messages = await service.messages(draft.id)

    expect(messages).toEqual([])
    const hasMessagesCall = sdk.calls.some((c) => c.method === 'getSessionMessages')
    expect(hasMessagesCall).toBe(false)
  })

  test('deleteDraft removes it from the list', async () => {
    const { service } = freshSetup()
    const draft = service.createDraft('p1', {})

    service.deleteDraft(draft.id)
    const result = await service.list('p1')

    expect(result.every((s) => s.id !== draft.id)).toBe(true)
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
})
