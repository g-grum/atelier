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

export function SessionListItem({ session, active, state, onSelect, onDelete }: SessionListItemProps) {
  return (
    <div
      className={`sess${active ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <div className="row1">
        <span className="dot" data-state={state} aria-hidden="true" />
        <span className="name">{session.name ?? 'Nouvelle session'}</span>
        <span className="when">{relativeTime(session.updatedAt)}</span>
        {onDelete !== undefined && (
          <button
            type="button"
            className="del"
            aria-label="Supprimer le brouillon"
            onClick={(event) => {
              event.stopPropagation()
              onDelete()
            }}
          >
            ×
          </button>
        )}
      </div>
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
