import { useState } from 'react'
import type { SessionPermissionMode } from '@atelier/shared'

export type PermissionModeGateProps = {
  /** Persists the choice (PATCH /sessions/:id) — the gate stays until the refetched session carries it. `remember` demande EN PLUS d'enregistrer le mode comme défaut global (PATCH /preferences, indépendant). */
  onChoose: (mode: SessionPermissionMode, remember: boolean) => void
  /** Patch in flight — both buttons lock to avoid a double answer. */
  pending: boolean
}

/**
 * Per-session permissions question. Rendered above the composer while the
 * active session's permissionMode is null; the composer stays disabled until
 * an answer lands. The dangerous choice is red (never amber — that is
 * reserved for tool permissions). Depuis la spec 2026-07-31, « Se souvenir »
 * enregistre le choix comme défaut global : les prochaines sessions naissent
 * stampées et ne montrent plus le gate (révocable dans les réglages).
 */
export function PermissionModeGate({ onChoose, pending }: PermissionModeGateProps) {
  const [remember, setRemember] = useState(false)
  return (
    <div className="perm-gate" role="group" aria-label="Session permissions">
      <span className="perm-gate-text">How should tool permissions be handled for this session?</span>
      <div className="perm-gate-actions">
        <button type="button" className="perm-gate-btn" disabled={pending} onClick={() => onChoose('default', remember)}>
          Normal permissions
        </button>
        <button type="button" className="perm-gate-btn danger" disabled={pending} onClick={() => onChoose('bypassPermissions', remember)}>
          Skip permissions (dangerous)
        </button>
      </div>
      <label className="perm-gate-remember">
        <input
          type="checkbox"
          checked={remember}
          disabled={pending}
          onChange={(event) => setRemember(event.target.checked)}
        />
        Remember this choice for new sessions (can be changed in settings)
      </label>
    </div>
  )
}
