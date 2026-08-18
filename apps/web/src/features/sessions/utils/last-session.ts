/**
 * Launch restore persistence (spec 2026-07-24): the last active session,
 * remembered per-machine in localStorage so the next launch reopens it and
 * the composer is typeable immediately. Best-effort by design — unavailable
 * or corrupt storage reads as "nothing stored", never a crash.
 */

import type { Dictionary } from '@atelier/core/types'

const KEY = 'atelier:lastSession'

export type LastSession = { sessionId: string; projectId: string }

export function readLastSession(): LastSession | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { sessionId, projectId } = parsed as Dictionary<unknown>
    if (typeof sessionId !== 'string' || typeof projectId !== 'string') return null
    return { sessionId, projectId }
  } catch {
    return null
  }
}

export function writeLastSession(value: LastSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    // Storage full/unavailable — the restore is a comfort, not a requirement.
  }
}

export function clearLastSession(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Same best-effort stance as write.
  }
}
