import { type ReactNode, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

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
 * Markdown pipeline (react-markdown + gfm + highlight + langages hljs) isolé
 * dans son propre chunk — importé paresseusement par MessageItem pour sortir
 * ~500 kB du bundle principal. Export default requis par React.lazy.
 */
export default function MarkdownBody({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{ pre: CodeBlock }}
    >
      {text}
    </Markdown>
  )
}
