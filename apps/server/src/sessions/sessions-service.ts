import { randomUUID } from 'node:crypto'
import type { ChatMessage, Project, SessionPermissionMode, SessionSummary } from '@atelier/shared'
import type { AppData } from '../store/app-data'
import type { SdkClient } from '../sdk/sdk-client'
import type { SessionStreamRegistry } from '../stream/session-stream'

/** Deletion target not found anywhere (no draft record, no SDK session in any registered project) — the route maps this to 404. */
export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session introuvable : ${id}`)
    this.name = 'SessionNotFoundError'
  }
}

export class SessionsService {
  constructor(
    private readonly sdk: SdkClient,
    private readonly data: AppData,
    private readonly streams: SessionStreamRegistry,
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
    // Défaut global stampé à la naissance (spec 2026-07-31) — null = le gate demandera.
    // Les DEUX null codés en dur (record stocké + summary retourné) passent par cette valeur.
    const permissionMode = preferences.defaultPermissionMode ?? null
    const createdAt = new Date().toISOString()

    this.data.update((d) => {
      d.drafts.push({ id, projectId, name: name ?? null, model: resolvedModel, createdAt, permissionMode })
    })

    return {
      id,
      projectId,
      name: name ?? null,
      updatedAt: createdAt,
      messageCount: 0,
      isDraft: true,
      model: resolvedModel,
      permissionMode,
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

  /**
   * Unified deletion — drafts and real sessions (spec 2026-07-17). Dispose runs
   * FIRST and for drafts too: a draft whose first turn is in flight must have
   * its turn aborted, or the "deleted" draft would materialize into a
   * resurrected SDK session; dispose-before-delete also guarantees the SDK
   * process is no longer appending to the JSONL when it is removed. (Accepted
   * narrow race: a JSONL flushed despite the abort simply reappears in the
   * list, deletable again.)
   */
  async delete(id: string): Promise<void> {
    const isDraft = this.data.get().drafts.some((d) => d.id === id)
    this.streams.dispose(id)

    if (isDraft) {
      this.data.update((d) => {
        d.drafts = d.drafts.filter((x) => x.id !== id)
      })
      return
    }

    const sdkId = this.data.resolveSessionId(id)
    const project = await this.findOwningProject(sdkId)
    if (project === undefined) throw new SessionNotFoundError(id)

    try {
      await this.sdk.deleteSession(sdkId, project.path)
    } catch (err) {
      // The SDK throws an untyped Error when the session vanished between the
      // scan and the delete — message-sniffing is the only discriminator (spec).
      if (err instanceof Error && /not found/i.test(err.message)) {
        // Definitively gone: forget its AppData entries too, or they leak forever.
        this.forgetSession(sdkId)
        throw new SessionNotFoundError(id)
      }
      throw err
    }

    this.forgetSession(sdkId)
  }

  /**
   * DELETE /sessions/:id carries no project id — scan registered projects' dirs
   * (O(projects) local listSessions calls; fine for a personal app). Unreadable
   * folders are skipped, same tolerance as countSessions.
   */
  private async findOwningProject(sdkId: string): Promise<Project | undefined> {
    for (const project of this.data.get().projects) {
      try {
        const sessions = await this.sdk.listSessions(project.path)
        if (sessions.some((s) => s.id === sdkId)) return project
      } catch {
        // unreadable folder — skip
      }
    }
    return undefined
  }

  /** Drops the session-keyed AppData entries; usageEvents stay (spec). */
  private forgetSession(sdkId: string): void {
    this.data.update((d) => {
      delete d.modelOverrides[sdkId]
      delete d.permissionModes[sdkId]
      for (const [draftId, mapped] of Object.entries(d.draftMap)) {
        if (mapped === sdkId) delete d.draftMap[draftId]
      }
    })
  }
}
