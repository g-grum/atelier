import type { CSSProperties, ReactNode, Ref } from 'react'
import type { WidgetHeight, WidgetInstance } from '@atelier/shared'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu'

const HEIGHTS: WidgetHeight[] = ['S', 'M', 'L']

export type WidgetFrameProps = {
  instance: WidgetInstance
  title: string
  /** Emits a patched COPY — the caller owns persistence (optimistic PUT). */
  onChange: (next: WidgetInstance) => void
  onRemove: (id: string) => void
  /** Present only for configurable types (github-prs) — hides the item otherwise. */
  onConfigure?: () => void
  /** Spread onto the drag handle by DashboardGrid (dnd-kit listeners). */
  dragHandleProps?: Record<string, unknown>
  /** dnd-kit's setNodeRef — must land on a box-generating element (the section itself) to be measurable. */
  frameRef?: Ref<HTMLElement>
  /** dnd-kit's transform/transition while dragging. */
  style?: CSSProperties
  children: ReactNode
}

/**
 * Widget chrome: heading (the frame OWNS the h3 — wrapped panels render
 * body-only), drag handle, ⋯ menu (width, height, configure, remove).
 * Layout classes (`span-*`, `h-*`) are consumed by .dash-grid in styles.css.
 */
export function WidgetFrame({ instance, title, onChange, onRemove, onConfigure, dragHandleProps, frameRef, style, children }: WidgetFrameProps) {
  const isFull = instance.span === 2

  return (
    <section ref={frameRef} style={style} className={`widget span-${instance.span} h-${instance.height}`} role="group" aria-label={title}>
      <header className="widget-head">
        <button type="button" className="widget-drag" aria-label={`Move ${title}`} {...dragHandleProps}>
          ⠿
        </button>
        <h3>{title}</h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="widget-menu-btn" aria-label={`Widget options — ${title}`}>
              ⋯
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="widget-menu">
            <DropdownMenuItem onSelect={() => onChange({ ...instance, span: isFull ? 1 : 2 })}>
              {isFull ? 'Half width' : 'Full width'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {HEIGHTS.filter((height) => height !== instance.height).map((height) => (
              <DropdownMenuItem key={height} onSelect={() => onChange({ ...instance, height })}>
                Height {height}
              </DropdownMenuItem>
            ))}
            {onConfigure !== undefined && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onConfigure()}>Configure…</DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onRemove(instance.id)}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="widget-body">{children}</div>
    </section>
  )
}
