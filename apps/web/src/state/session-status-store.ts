import type { SessionState, SessionStatusEvent } from '@atelier/shared'

export type SessionStatusSnapshot = {
  statuses: ReadonlyMap<string, SessionState>
  waiting: ReadonlySet<string>
}

/**
 * Source externe des pastilles (spec 2026-08-02). Le bleu est dérivé d'une
 * TRANSITION `streaming → (idle|error)` hors session focalisée — jamais d'un état
 * absolu, pour que le snapshot initial (sessions déjà idle) n'allume rien.
 */
export class SessionStatusStore {
  private statuses = new Map<string, SessionState>()
  private waiting = new Set<string>()
  private activeSessionId: string | null = null
  private snapshot: SessionStatusSnapshot = { statuses: this.statuses, waiting: this.waiting }
  private readonly listeners = new Set<() => void>()

  /**
   * Fin de tour (transition streaming → idle|error) : c'est le SEUL moment où
   * le JSONL de session est garanti flushé côté SDK — App s'en sert pour
   * refetcher la liste des sessions (session fraîchement matérialisée,
   * updatedAt, messageCount). Jamais déclenché par le snapshot initial du hub
   * (prev absent ≠ streaming).
   */
  onTurnSettled?: (sessionId: string) => void

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SessionStatusSnapshot => this.snapshot

  handle(event: SessionStatusEvent): void {
    const { sessionId, state } = event
    const prev = this.statuses.get(sessionId)
    // Aucun changement d'état → aucune mutation, snapshot stable. Sûr même pour un
    // 'streaming' répété : une session dans `waiting` a toujours statuses=idle|error
    // (jamais streaming), donc ce retour anticipé ne peut pas sauter un `waiting.delete`.
    if (prev === state) return
    this.statuses = new Map(this.statuses).set(sessionId, state)
    let waiting = this.waiting
    if (state === 'streaming') {
      if (waiting.has(sessionId)) { waiting = new Set(waiting); waiting.delete(sessionId) }
    } else if (prev === 'streaming' && sessionId !== this.activeSessionId) {
      waiting = new Set(waiting).add(sessionId)
    }
    this.waiting = waiting
    this.commit()
    if (prev === 'streaming') this.onTurnSettled?.(sessionId)
  }

  setActive(sessionId: string | null): void {
    const changed = sessionId !== null && this.waiting.has(sessionId)
    this.activeSessionId = sessionId
    if (changed) {
      const waiting = new Set(this.waiting)
      waiting.delete(sessionId as string)
      this.waiting = waiting
      this.commit()
    }
  }

  private commit(): void {
    this.snapshot = { statuses: this.statuses, waiting: this.waiting }
    for (const listener of this.listeners) listener()
  }
}
