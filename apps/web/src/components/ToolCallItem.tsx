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
 * (checkmark/cross + diffstat + :line), and a hover-revealed IDE button that
 * opens the file at its line (POST /api/open-in-ide).
 */
export function ToolCallItem({ item, onOpenInIde }: ToolCallItemProps) {
  const [expanded, setExpanded] = useState(false)
  const { file, line } = item
  return (
    <>
      <button type="button" className={`tool ${kindClass(item.tool)}`} onClick={() => setExpanded((open) => !open)} aria-expanded={expanded}>
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
        {file !== undefined && (
          <span
            className="ide-btn"
            role="button"
            tabIndex={0}
            aria-label={`Ouvrir dans l’IDE${line !== undefined ? ` à la ligne ${line}` : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              onOpenInIde(file, line)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                event.stopPropagation()
                onOpenInIde(file, line)
              }
            }}
          >
            <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
            </svg>
            IDE
          </span>
        )}
      </button>
      {expanded && <div className="tool-detail">{detail(item)}</div>}
    </>
  )
}

function detail(item: ToolChatItem): string {
  if (item.result === undefined) return 'en cours…'
  if (item.result.summary !== '') return item.result.summary
  return item.result.ok ? 'terminé' : 'échec'
}
