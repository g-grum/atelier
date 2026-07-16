import { useState } from 'react'
import type { StreamState } from '../state/stream-reducer'

export type ComposerProps = {
  /** No session selected — dimmed and inert. */
  disabled: boolean
  /** While 'streaming' the action button becomes Stop and submits are no-ops. */
  status: StreamState['status']
  /** Returns whether the controller accepted the message (refused mid-turn). */
  onSend: (text: string) => boolean
  /** Sends the abort ClientMessage — the spec's only way to stop a turn. */
  onAbort: () => void
}

export function Composer({ disabled, status, onSend, onAbort }: ComposerProps) {
  const [text, setText] = useState('')
  const streaming = status === 'streaming'

  const trySend = () => {
    // Mirror the controller's mid-turn refusal: while streaming, typing stays
    // possible but Stop is the only action — Enter/⌘↵ must not send.
    if (streaming) return
    const trimmed = text.trim()
    if (trimmed === '') return
    // Keep the draft text when the controller refuses (mid-turn / resync).
    if (onSend(trimmed)) setText('')
  }

  return (
    <div className="composer">
      <div className={`box${disabled ? ' disabled' : ''}`}>
        <textarea
          rows={1}
          value={text}
          disabled={disabled}
          placeholder="Répondre à Claude…"
          aria-label="Répondre à Claude"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // ⌘↵ always sends; plain Enter sends too (Shift+Enter = newline).
            if (event.key === 'Enter' && (event.metaKey || !event.shiftKey)) {
              event.preventDefault()
              trySend()
            }
          }}
        />
        <kbd>⌘↵</kbd>
        <button
          type="button"
          className={`action${streaming ? ' stop' : ''}`}
          disabled={disabled}
          aria-label={streaming ? 'Arrêter la génération' : 'Envoyer le message'}
          onClick={streaming ? onAbort : trySend}
        >
          {streaming ? (
            // Square = stop; red accent (never amber — that is permissions-only).
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
