import type { SessionSummary } from '@atelier/shared'

/**
 * Sidebar state dots (mockup v4.2 semantics):
 * - run: the session is streaming right now (mint, pulsing)
 * - idle: nothing happened yet — drafts and empty sessions (faint, filled)
 * - done: the session has history and is not streaming (outlined)
 */
export type SessionDotState = 'run' | 'idle' | 'done'

export type SessionListItemProps = {
  session: SessionSummary
  active: boolean
  state: SessionDotState
  onSelect: () => void
  /** Present only for drafts — real sessions have no delete affordance in v0.1. */
  onDelete?: () => void
}

/**
 * The row is a plain div holding two SIBLING native buttons (select + delete)
 * — never a button nested in a button: ARIA `button` has presentational
 * children, so a nested delete control would be flattened away from assistive
 * tech (same fix as ToolCallItem). The delete button is revealed on :hover AND
 * :focus-within (styles.css), so tabbing onto the select button makes it
 * visible and the next Tab reaches it.
 */
export function SessionListItem({ session, active, state, onSelect, onDelete }: SessionListItemProps) {
  return (
    <div className={`sess${active ? ' active' : ''}`}>
      <button type="button" className="sess-btn" onClick={onSelect}>
        <span className="dot" data-state={state} aria-hidden="true" />
        <span className="name">{session.name ?? 'Nouvelle session'}</span>
        <span className="when">{relativeTime(session.updatedAt)}</span>
      </button>
      {onDelete !== undefined && (
        <button type="button" className="del" aria-label="Supprimer le brouillon" onClick={onDelete}>
          ×
        </button>
      )}
    </div>
  )
}

/** Compact times per the mockup: "now", then "12 min", then clock time, then a date. */
function relativeTime(iso: string): string {
  const then = new Date(iso)
  const elapsedMs = Date.now() - then.getTime()
  if (Number.isNaN(then.getTime())) return ''
  if (elapsedMs < 60_000) return 'now'
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)} min`
  if (elapsedMs < 86_400_000) return then.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  return then.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}
