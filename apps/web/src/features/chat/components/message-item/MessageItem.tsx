import { lazy, type ReactNode, Suspense, useLayoutEffect, useRef, useState } from 'react'

// Pipeline markdown (~500 kB : react-markdown + gfm + hljs) chargé paresseusement —
// il ne sert qu'aux messages assistant, inutile de l'embarquer dans le chunk principal.
const MarkdownBody = lazy(() => import('@/features/chat/components/markdown-body/MarkdownBody'))

export type MessageItemProps = {
  role: 'user' | 'assistant'
  text: string
  /** Message accepted mid-turn, waiting in the client queue — dimmed + « En attente » tag. */
  queued?: boolean
  /** Tool rows / typing indicator rendered inside the message column (mockup nesting). */
  children?: ReactNode
}

/** Collapsed cap for sticky user messages (spec 2026-08-21) — click expands. */
export const USER_COLLAPSE_MAX_PX = 200

/**
 * One chat message per mockup v5.0: user = neutral "G" avatar (surface-2 / muted)
 * + surface-2 bubble; assistant = solid accent avatar + markdown-rendered body.
 * User text stays raw (pre-wrap) — markdown is assistant-only, like claude.ai.
 *
 * User messages are sticky (CSS .msg.user) — the turn's prompt stays pinned to
 * the top of the scroll while its response scrolls. A message taller than
 * USER_COLLAPSE_MAX_PX is capped with a bottom fade and toggles on click.
 */
export function MessageItem({ role, text, queued = false, children }: MessageItemProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // scrollHeight reports the FULL content height even under the max-height cap,
  // so the measurement is stable whatever the current state. 0 = no layout
  // (happy-dom) — leave the plain, non-collapsible rendering alone.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (role === 'user' && el !== null && el.scrollHeight > 0) {
      setOverflowing(el.scrollHeight > USER_COLLAPSE_MAX_PX + 1)
    }
  }, [role, text])

  const collapsible = role === 'user' && overflowing
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
            <div
              ref={bodyRef}
              className={`body${collapsible ? (expanded ? ' expandable expanded' : ' expandable collapsed') : ''}`}
              // The whole bubble toggles — larger target than a dedicated chevron.
              role={collapsible ? 'button' : undefined}
              tabIndex={collapsible ? 0 : undefined}
              aria-expanded={collapsible ? expanded : undefined}
              aria-label={collapsible ? (expanded ? 'Collapse message' : 'Expand message') : undefined}
              onClick={collapsible ? () => setExpanded((e) => !e) : undefined}
              onKeyDown={
                collapsible
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setExpanded((e) => !e)
                      }
                    }
                  : undefined
              }
            >
              {text}
            </div>
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
