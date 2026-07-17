import { useEffect, useRef, useState } from 'react'
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

/** Growth cap (~8 lines) — beyond it the textarea scrolls internally. */
const MAX_TEXTAREA_HEIGHT_PX = 200

export function Composer({ disabled, status, onSend, onAbort }: ComposerProps) {
  const [text, setText] = useState('')
  const streaming = status === 'streaming'
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Autofocus when a session becomes active (fresh draft or opened session):
  // the user can start typing without clicking the textarea first. Runs only
  // on the disabled→enabled transition, so it never steals focus mid-use.
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus()
  }, [disabled])

  // Auto-grow: the textarea follows its content up to a cap, then scrolls.
  // 'auto' first so a shrinking draft (deleted lines, post-send reset) can
  // shrink back; scrollHeight 0 = no layout (tests) — leave the height alone.
  useEffect(() => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = 'auto'
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`
  }, [text])

  const trySend = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    // Mid-turn sends are accepted and QUEUED by the controller (sent at next
    // idle) — the composer no longer blocks them. Keep the draft only when the
    // controller refuses outright (no socket / resync in flight).
    if (onSend(trimmed)) setText('')
  }

  return (
    <div className="composer">
      <div className={`box${disabled ? ' disabled' : ''}`}>
        <textarea
          ref={textareaRef}
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
