import type { ReactNode } from 'react'

export type MessageItemProps = {
  role: 'user' | 'assistant'
  text: string
  /** Message accepted mid-turn, waiting in the client queue — dimmed + « En attente » tag. */
  queued?: boolean
  /** Tool rows / typing indicator rendered inside the message column (mockup nesting). */
  children?: ReactNode
}

/**
 * One chat message per mockup v4.2: user = blue-tinted "G" avatar + surface-2
 * bubble; assistant = indigo→magenta gradient avatar + plain text body.
 */
export function MessageItem({ role, text, queued = false, children }: MessageItemProps) {
  return (
    <div className={`msg ${role}${queued ? ' queued' : ''}`}>
      <div className="avatar" aria-hidden="true">
        {role === 'user' ? 'G' : '◆'}
      </div>
      <div className="col">
        <div className="who">
          <b>{role === 'user' ? 'Germain' : 'Claude'}</b>
          {queued && <span className="queued-tag">En attente</span>}
        </div>
        {text !== '' && <div className="body">{text}</div>}
        {children}
      </div>
    </div>
  )
}

/** Three pulsing dots — shown while Claude streams but no text has arrived yet. */
export function TypingIndicator() {
  return (
    <div className="typing" aria-label="Claude écrit">
      <i />
      <i />
      <i />
    </div>
  )
}
