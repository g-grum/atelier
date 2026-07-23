import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AlwaysRule, Preferences, Project, RateLimitSnapshot, SessionPermissionMode, UsageEvent, WidgetInstance } from '@atelier/shared'
import { DEFAULT_WIDGETS } from '@atelier/shared'

/** permissionMode is optional for on-disk backward compatibility — absent/undefined means "not chosen yet" (same as null). */
export type Draft = { id: string; projectId: string; name: string | null; model: string; createdAt: string; permissionMode?: SessionPermissionMode | null }
// UsageEvent now lives in @atelier/shared (GET /api/usage/history ships it — single contract);
// re-exported so store-side importers keep working.
export type { UsageEvent }

export type AppDataShape = {
  projects: Project[]
  preferences: Preferences
  drafts: Draft[]
  draftMap: Record<string, string>
  modelOverrides: Record<string, string>
  /** Per-session permissions answer, keyed by SDK session id. Absent key = the question is still pending. */
  permissionModes: Record<string, SessionPermissionMode>
  rules: AlwaysRule[]
  usageEvents: UsageEvent[]
  /** Last-known plan limit per window (five_hour, seven_day, …) — REAL SDK data, honest-data policy. */
  rateLimits: Record<string, RateLimitSnapshot>
  /** Dashboard layout — array order = display order. Spec 2026-07-21. */
  widgets: WidgetInstance[]
}

const EMPTY: AppDataShape = {
  projects: [],
  preferences: {
    ide: 'webstorm',
    defaultModel: 'claude-fable-5',
    // Default budgets are honest ESTIMATES (no public API exposes plan limits);
    // the user calibrates them from settings — spec « Usage & limits ».
    windowBudgetTokens: 2_000_000,
    weeklyBudgetTokens: 12_000_000,
  },
  drafts: [],
  draftMap: {},
  modelOverrides: {},
  permissionModes: {},
  rules: [],
  usageEvents: [],
  rateLimits: {},
  widgets: [...DEFAULT_WIDGETS],
}

const USAGE_RETENTION_MS = 7 * 86400_000

export class AppData {
  private data: AppDataShape

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<AppDataShape>
      // Deep-merge preferences: a shallow `{ ...EMPTY, ...parsed }` replaces the
      // nested object wholesale, so a v0.1 file (no budgets) would lose the new
      // defaults. Merging per-key keeps saved values AND future defaults.
      // Cloning EMPTY up front means a legacy file missing ANY object/array key
      // gets a fresh copy — one instance's in-place mutation can never pollute
      // the module-level EMPTY or future instances (the trap the widgets
      // clone-guard test pins down).
      const base = structuredClone(EMPTY)
      this.data = { ...base, ...parsed, preferences: { ...base.preferences, ...parsed.preferences } }
    } else {
      this.data = structuredClone(EMPTY)
    }
  }

  get(): Readonly<AppDataShape> {
    return this.data
  }

  update(mutate: (draft: AppDataShape) => void): void {
    mutate(this.data)
    this.flush()
  }

  /** Latest snapshot wins per window — the panel shows current state, not history. */
  recordRateLimit(snapshot: RateLimitSnapshot): void {
    this.data.rateLimits[snapshot.window] = snapshot
    this.flush()
  }

  recordUsage(event: UsageEvent): void {
    const cutoff = Date.now() - USAGE_RETENTION_MS
    this.data.usageEvents = [...this.data.usageEvents, event].filter(
      (entry) => Date.parse(entry.at) >= cutoff
    )
    this.flush()
  }

  /** Materialization is loss-less: the draft's model (and permissions answer, if given) moves to the SDK id's overrides; the deferred name is returned so the caller can apply `renameSession`. */
  mapDraft(draftId: string, sdkSessionId: string): { deferredName: string | null } {
    const draft = this.data.drafts.find((entry) => entry.id === draftId)
    this.data.draftMap[draftId] = sdkSessionId
    if (draft) this.data.modelOverrides[sdkSessionId] = draft.model
    if (draft?.permissionMode != null) this.data.permissionModes[sdkSessionId] = draft.permissionMode
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
