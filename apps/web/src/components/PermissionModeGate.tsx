import type { SessionPermissionMode } from '@atelier/shared'

export type PermissionModeGateProps = {
  /** Persists the choice (PATCH /sessions/:id) — the gate stays until the refetched session carries it. */
  onChoose: (mode: SessionPermissionMode) => void
  /** Patch in flight — both buttons lock to avoid a double answer. */
  pending: boolean
}

/**
 * Per-session permissions question — spec « chaque session doit demander ».
 * Rendered above the composer while the active session's permissionMode is
 * null; the composer stays disabled until an answer lands. The dangerous
 * choice is red (never amber — that is reserved for tool permissions).
 */
export function PermissionModeGate({ onChoose, pending }: PermissionModeGateProps) {
  return (
    <div className="perm-gate" role="group" aria-label="Permissions de la session">
      <span className="perm-gate-text">Comment gérer les permissions d’outils pour cette session ?</span>
      <div className="perm-gate-actions">
        <button type="button" className="perm-gate-btn" disabled={pending} onClick={() => onChoose('default')}>
          Permissions normales
        </button>
        <button type="button" className="perm-gate-btn danger" disabled={pending} onClick={() => onChoose('bypassPermissions')}>
          Skip permissions (dangereux)
        </button>
      </div>
    </div>
  )
}
