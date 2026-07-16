import { randomUUID } from 'node:crypto'
import type { ChatMessage, SessionSummary } from '@atelier/shared'
import type { AppData } from '../store/app-data'
import type { SdkClient } from '../sdk/sdk-client'

export class SessionsService {
  constructor(
    private readonly sdk: SdkClient,
    private readonly data: AppData,
  ) {}

  async list(projectId: string): Promise<SessionSummary[]> {
    const { projects, drafts, modelOverrides, preferences } = this.data.get()
    const project = projects.find((p) => p.id === projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)

    const sdkSessions = await this.sdk.listSessions(project.path)

    const sdkSummaries: SessionSummary[] = sdkSessions.map((s) => ({
      id: s.id,
      projectId,
      name: s.name,
      updatedAt: s.updatedAt,
      messageCount: s.messageCount,
      isDraft: false,
      model: modelOverrides[s.id] ?? preferences.defaultModel,
    }))

    const draftSummaries: SessionSummary[] = drafts
      .filter((d) => d.projectId === projectId)
      .map((d) => ({
        id: d.id,
        projectId,
        name: d.name,
        updatedAt: d.createdAt,
        messageCount: 0,
        isDraft: true,
        model: d.model,
      }))

    return [...draftSummaries, ...sdkSummaries]
  }

  /**
   * Sessions visible for a project: SDK sessions on its path + its unsent drafts.
   * NEVER throws — an unreadable folder (or unknown id) yields 0 so the projects
   * list keeps rendering even when one folder's history cannot be read.
   */
  async countSessions(projectId: string): Promise<number> {
    try {
      return (await this.list(projectId)).length
    } catch {
      return 0
    }
  }

  createDraft(projectId: string, { name, model }: { name?: string; model?: string }): SessionSummary {
    const { preferences } = this.data.get()
    const id = randomUUID()
    const resolvedModel = model ?? preferences.defaultModel
    const createdAt = new Date().toISOString()

    this.data.update((d) => {
      d.drafts.push({ id, projectId, name: name ?? null, model: resolvedModel, createdAt })
    })

    return {
      id,
      projectId,
      name: name ?? null,
      updatedAt: createdAt,
      messageCount: 0,
      isDraft: true,
      model: resolvedModel,
    }
  }

  async rename(id: string, name: string): Promise<void> {
    const draft = this.data.get().drafts.find((d) => d.id === id)
    if (draft) {
      this.data.update((d) => {
        const entry = d.drafts.find((x) => x.id === id)
        if (entry) entry.name = name
      })
      return
    }
    await this.sdk.renameSession(this.data.resolveSessionId(id), name)
  }

  setModel(id: string, model: string): void {
    const draft = this.data.get().drafts.find((d) => d.id === id)
    if (draft) {
      this.data.update((d) => {
        const entry = d.drafts.find((x) => x.id === id)
        if (entry) entry.model = model
      })
      return
    }
    this.data.update((d) => {
      d.modelOverrides[this.data.resolveSessionId(id)] = model
    })
  }

  async messages(id: string): Promise<ChatMessage[]> {
    const isDraft = this.data.get().drafts.some((d) => d.id === id)
    if (isDraft) return []
    return this.sdk.getSessionMessages(this.data.resolveSessionId(id))
  }

  deleteDraft(id: string): void {
    this.data.update((d) => {
      d.drafts = d.drafts.filter((x) => x.id !== id)
    })
  }
}
