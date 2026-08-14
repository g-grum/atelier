import { lazy, type ReactNode, Suspense } from 'react'

// Pipeline markdown (~500 kB : react-markdown + gfm + hljs) chargé paresseusement —
// il ne sert qu'aux messages assistant, inutile de l'embarquer dans le chunk principal.
const MarkdownBody = lazy(() => import('./MarkdownBody'))

export type MessageItemProps = {
  role: 'user' | 'assistant'
  text: string
  /** Message accepted mid-turn, waiting in the client queue — dimmed + « En attente » tag. */
  queued?: boolean
  /** Tool rows / typing indicator rendered inside the message column (mockup nesting). */
  children?: ReactNode
}

/**
 * One chat message per mockup v5.0: user = neutral "G" avatar (surface-2 / muted)
 * + surface-2 bubble; assistant = solid accent avatar + markdown-rendered body.
 * User text stays raw (pre-wrap) — markdown is assistant-only, like claude.ai.
 */
export function MessageItem({ role, text, queued = false, children }: MessageItemProps) {
  return (
    <div className={`msg ${role}${queued ? ' queued' : ''}`}>
      <div className="avatar" aria-hidden="true">
        {role === 'user' ? 'U' : '◆'}
      </div>
      <div className="col">
        <div className="who">
          <b>{role === 'user' ? 'You' : 'Claude'}</b>
          {queued && <span className="queued-tag">Queued</span>}
        </div>
        {text !== '' &&
          (role === 'assistant' ? (
            <div className="body markdown">
              {/* Fallback texte brut le temps du chargement du chunk markdown. */}
              <Suspense fallback={<span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>}>
                <MarkdownBody text={text} />
              </Suspense>
            </div>
          ) : (
            <div className="body">{text}</div>
          ))}
        {children}
      </div>
    </div>
  )
}

/** Three pulsing dots — shown while Claude streams but no text has arrived yet. */
export function TypingIndicator() {
  return (
    <div className="typing" aria-label="Claude is typing">
      <i />
      <i />
      <i />
    </div>
  )
}
