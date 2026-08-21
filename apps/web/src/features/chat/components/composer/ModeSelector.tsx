import { useEffect, useRef, useState } from 'react'
import type { SessionPermissionMode } from '@atelier/shared'

export type ModeSelectorProps = {
  mode: SessionPermissionMode
  disabled: boolean
  /** Persists the choice (PATCH session) — effective from the next turn. */
  onChange: (mode: SessionPermissionMode) => void
}

type ModeEntry = { value: SessionPermissionMode; label: string; description: string; danger?: boolean }

/** The 4-mode contract (spec 2026-08-21) — labels are what the composer button shows. */
export const MODES: readonly ModeEntry[] = [
  { value: 'default', label: 'Auto', description: 'Ask before sensitive tools' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Auto-approve file edits' },
  { value: 'plan', label: 'Plan', description: 'Plan first, approve before it runs' },
  { value: 'bypassPermissions', label: 'Skip perms', description: 'Never ask (dangerous)', danger: true },
]

/**
 * Compact per-session mode picker living inside the composer box, next to the
 * submit button. Opens an upward listbox (same grammar as .command-popover).
 * Red is for the dangerous mode only — amber stays reserved for permissions.
 */
export function ModeSelector({ mode, disabled, onChange }: ModeSelectorProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = MODES.find((m) => m.value === mode) ?? MODES[0]!

  // Outside click closes — mousedown, or the composer textarea's blur/refocus
  // dance would swallow the click.
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  return (
    <div ref={rootRef} className="mode-selector">
      <button
        type="button"
        className={`mode-btn${current.danger ? ' danger' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Permission mode: ${current.label}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
      >
        {current.label}
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m18 15-6-6-6 6" />
        </svg>
      </button>
      {open && (
        <ul className="mode-popover" role="listbox" aria-label="Permission mode">
          {MODES.map((entry) => (
            <li key={entry.value}>
              <button
                type="button"
                role="option"
                aria-selected={entry.value === mode}
                className={`mode-option${entry.value === mode ? ' selected' : ''}${entry.danger ? ' danger' : ''}`}
                onClick={() => {
                  setOpen(false)
                  if (entry.value !== mode) onChange(entry.value)
                }}
              >
                <span className="mode-label">{entry.label}</span>
                <span className="mode-desc">{entry.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
