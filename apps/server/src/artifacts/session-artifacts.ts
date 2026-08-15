import { resolve } from 'node:path'
import type { SessionArtifact, StatusHubEvent } from '@atelier/shared'
import { extractImagePaths, normalizeToProject } from './artifact-lib'

export type SessionArtifactsTrackerOpts = {
  /** Hub broadcast — same sink the registry uses for session_status/autopilot_status. */
  publish: (event: StatusHubEvent) => void
  /** Injected fs probe (absolute path) — real callers pass an existsSync wrapper. */
  fileExists: (absPath: string) => boolean
  /** Injected clock for deterministic tests. */
  now?: () => string
}

/**
 * Per-session list of images produced by tool calls (spec 2026-08-14). Fed by
 * the stream registry's onToolUse hook; publishes artifacts_status on every
 * change. Pure bookkeeping — the bytes are served by the artifacts route.
 */
export class SessionArtifactsTracker {
  private readonly bySession = new Map<string, SessionArtifact[]>()

  constructor(private readonly opts: SessionArtifactsTrackerOpts) {}

  /** Current artifacts of a session (chronological order, oldest first). */
  get(sessionId: string): SessionArtifact[] {
    return this.bySession.get(sessionId) ?? []
  }

  /**
   * Observes one tool_use. Any referenced image that resolves under the
   * project root AND exists on disk is recorded (dedup by path — a re-touch
   * refreshes addedAt). One publish per tool_use, only when something changed.
   */
  onToolUse(sessionId: string, projectId: string, projectRoot: string, toolName: string, input: unknown): void {
    const candidates = extractImagePaths(toolName, input)
    if (candidates.length === 0) return
    const addedAt = (this.opts.now ?? (() => new Date().toISOString()))()
    let changed = false
    const list = this.bySession.get(sessionId) ?? []
    for (const candidate of candidates) {
      const rel = normalizeToProject(projectRoot, candidate)
      if (rel === null) continue
      if (!this.opts.fileExists(resolve(projectRoot, rel))) continue
      const existing = list.findIndex((a) => a.path === rel)
      if (existing >= 0) list.splice(existing, 1)
      list.push({ path: rel, addedAt })
      changed = true
    }
    if (!changed) return
    this.bySession.set(sessionId, list)
    this.opts.publish({ type: 'artifacts_status', sessionId, projectId, artifacts: [...list] })
  }
}
