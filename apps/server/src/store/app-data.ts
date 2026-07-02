import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AlwaysRule, Preferences, Project } from '@atelier/shared'

export type Draft = { id: string; projectId: string; name: string | null; model: string; createdAt: string }
/** All four counters persist — the v0.2 forecast's fidelity depends on cache counts; a lossy total can't be backfilled. */
export type UsageEvent = { at: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }

export type AppDataShape = {
  projects: Project[]
  preferences: Preferences
  drafts: Draft[]
  draftMap: Record<string, string>
  modelOverrides: Record<string, string>
  rules: AlwaysRule[]
  usageEvents: UsageEvent[]
}

const EMPTY: AppDataShape = {
  projects: [],
  preferences: { ide: 'webstorm', defaultModel: 'claude-fable-5' },
  drafts: [],
  draftMap: {},
  modelOverrides: {},
  rules: [],
  usageEvents: [],
}

const USAGE_RETENTION_MS = 7 * 86400_000

export class AppData {
  private data: AppDataShape

  constructor(private readonly filePath: string) {
    this.data = existsSync(filePath)
      ? { ...EMPTY, ...JSON.parse(readFileSync(filePath, 'utf8')) }
      : structuredClone(EMPTY)
  }

  get(): Readonly<AppDataShape> {
    return this.data
  }

  update(mutate: (draft: AppDataShape) => void): void {
    mutate(this.data)
    this.flush()
  }

  recordUsage(event: UsageEvent): void {
    const cutoff = Date.now() - USAGE_RETENTION_MS
    this.data.usageEvents = [...this.data.usageEvents, event].filter(
      (entry) => Date.parse(entry.at) >= cutoff
    )
    this.flush()
  }

  /** Materialization is loss-less: the draft's model moves to the SDK id's override; the deferred name is returned so the caller can apply `renameSession`. */
  mapDraft(draftId: string, sdkSessionId: string): { deferredName: string | null } {
    const draft = this.data.drafts.find((entry) => entry.id === draftId)
    this.data.draftMap[draftId] = sdkSessionId
    if (draft) this.data.modelOverrides[sdkSessionId] = draft.model
    this.data.drafts = this.data.drafts.filter((entry) => entry.id !== draftId)
    this.flush()
    return { deferredName: draft?.name ?? null }
  }

  resolveSessionId(id: string): string {
    return this.data.draftMap[id] ?? id
  }

  private flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
  }
}
