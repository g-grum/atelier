import { type ReactNode, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

export type MessageItemProps = {
  role: 'user' | 'assistant'
  text: string
  /** Message accepted mid-turn, waiting in the client queue — dimmed + « En attente » tag. */
  queued?: boolean
  /** Tool rows / typing indicator rendered inside the message column (mockup nesting). */
  children?: ReactNode
}

/** Fenced code block with a copy button — plugged into react-markdown as `pre`. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const code = ref.current?.querySelector('code')?.textContent ?? ''
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <div className="codeblock">
      <button type="button" className="codeblock-copy" onClick={copy}>
        {copied ? 'Copié' : 'Copier'}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
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
        {role === 'user' ? 'G' : '◆'}
      </div>
      <div className="col">
        <div className="who">
          <b>{role === 'user' ? 'Germain' : 'Claude'}</b>
          {queued && <span className="queued-tag">En attente</span>}
        </div>
        {text !== '' &&
          (role === 'assistant' ? (
            <div className="body markdown">
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{ pre: CodeBlock }}
              >
                {text}
              </Markdown>
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
    <div className="typing" aria-label="Claude écrit">
      <i />
      <i />
      <i />
    </div>
  )
}
