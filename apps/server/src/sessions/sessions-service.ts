import { randomUUID } from 'node:crypto'
import type { ChatMessage, SessionPermissionMode, SessionSummary } from '@atelier/shared'
import type { AppData } from '../store/app-data'
import type { SdkClient } from '../sdk/sdk-client'

export class SessionsService {
  constructor(
    private readonly sdk: SdkClient,
    private readonly data: AppData,
  ) {}

  async list(projectId: string): Promise<SessionSummary[]> {
    const { projects, drafts, modelOverrides, permissionModes, preferences } = this.data.get()
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
      // Absent key = never answered — the UI asks once per session (spec « chaque session demande »).
      permissionMode: permissionModes[s.id] ?? null,
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
        permissionMode: d.permissionMode ?? null,
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
      d.drafts.push({ id, projectId, name: name ?? null, model: resolvedModel, createdAt, permissionMode: null })
    })

    return {
      id,
      projectId,
      name: name ?? null,
      updatedAt: createdAt,
      messageCount: 0,
      isDraft: true,
      model: resolvedModel,
      permissionMode: null,
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

  /** Same draft-vs-SDK-session split as setModel — the answer must survive materialization (mapDraft moves it). */
  setPermissionMode(id: string, mode: SessionPermissionMode): void {
    const draft = this.data.get().drafts.find((d) => d.id === id)
    if (draft) {
      this.data.update((d) => {
        const entry = d.drafts.find((x) => x.id === id)
        if (entry) entry.permissionMode = mode
      })
      return
    }
    this.data.update((d) => {
      d.permissionModes[this.data.resolveSessionId(id)] = mode
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
