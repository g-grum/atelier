import { useState } from 'react'

export type ComposerProps = {
  /** No session selected — dimmed and inert. */
  disabled: boolean
  /** Returns whether the controller accepted the message (refused mid-turn). */
  onSend: (text: string) => boolean
}

export function Composer({ disabled, onSend }: ComposerProps) {
  const [text, setText] = useState('')

  const trySend = () => {
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
      </div>
    </div>
  )
}
