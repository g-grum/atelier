import { useState } from 'react'
import type { ToolKind } from '@atelier/shared'
import type { ChatItem } from '../state/stream-reducer'

export type ToolChatItem = Extract<ChatItem, { kind: 'tool' }>

export type ToolCallItemProps = {
  item: ToolChatItem
  onOpenInIde: (file: string, line?: number) => void
}

/** Mockup color mapping: Bash = cyan, Edit/Write = violet, Read/Other = muted. */
function kindClass(kind: ToolKind): string {
  if (kind === 'Bash') return 'bash'
  if (kind === 'Edit' || kind === 'Write') return 'edit'
  return 'other'
}

/**
 * Collapsible tool-call row: kind-colored left border, summary, status
 * (checkmark/cross + diffstat + :line), and an IDE button that opens the file
 * at its line (POST /api/open-in-ide).
 *
 * The row is a plain div holding two SIBLING native buttons (toggle + IDE) —
 * never a button nested in a button (non-conforming HTML, and a display:none
 * child of a hover-only reveal would be unreachable by keyboard). The IDE
 * button is revealed on :hover and :focus-within (styles.css), so tabbing
 * onto the toggle makes it visible and the next Tab reaches it.
 */
export function ToolCallItem({ item, onOpenInIde }: ToolCallItemProps) {
  const [expanded, setExpanded] = useState(false)
  const { file, line } = item
  return (
    <>
      <div className={`tool ${kindClass(item.tool)}`}>
        <button type="button" className="tool-toggle" onClick={() => setExpanded((open) => !open)} aria-expanded={expanded}>
          <span className="chev" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="kind">{item.tool}</span>
          <span>
            {item.summary}
            {line !== undefined && <span className="lnum">:{line}</span>}
          </span>
          <span className="status">
            {item.result !== undefined &&
              (item.result.ok ? (
                <span className="okt" aria-label="succès">
                  ✓
                </span>
              ) : (
                <span className="failt" aria-label="échec">
                  ✗
                </span>
              ))}
            {item.diffstat !== undefined && (
              <span>
                <span className="add">+{item.diffstat.added}</span> <span className="del">−{item.diffstat.removed}</span>
              </span>
            )}
          </span>
        </button>
        {file !== undefined && (
          <button
            type="button"
            className="ide-btn"
            aria-label={`Ouvrir dans l’IDE${line !== undefined ? ` à la ligne ${line}` : ''}`}
            onClick={() => onOpenInIde(file, line)}
          >
            <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
            </svg>
            IDE
          </button>
        )}
      </div>
      {expanded && <div className="tool-detail">{detail(item)}</div>}
    </>
  )
}

function detail(item: ToolChatItem): string {
  if (item.result === undefined) return 'en cours…'
  if (item.result.summary !== '') return item.result.summary
  return item.result.ok ? 'terminé' : 'échec'
}
