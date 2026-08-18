import type { ReactNode } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { WidgetInstance, WidgetType } from '@atelier/shared'
import { WIDGET_META, type WidgetMeta } from './widget-registry'
import { reorderWidgets } from './reorder'
import { WidgetFrame } from './WidgetFrame'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu'

export type DashboardGridProps = {
  widgets: WidgetInstance[]
  /** Every mutation (reorder, resize, add, remove, configure) emits the FULL next layout — the caller PUTs it optimistically. */
  onSave: (next: WidgetInstance[]) => void
  /** App owns data: maps an instance to its body. Return null for types the app cannot render (defensive). */
  renderWidget: (instance: WidgetInstance) => ReactNode
  /** Opens the config dialog for a configurable instance (chunk 3 wires it). */
  onConfigure?: (instance: WidgetInstance) => void
}

/** Layout/chrome only — no data fetching in here (spec boundary). */
export function DashboardGrid({ widgets, onSave, renderWidget, onConfigure }: DashboardGridProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const onDragEnd = (event: DragEndEvent) => {
    if (event.over === null) return
    const next = reorderWidgets(widgets, String(event.active.id), String(event.over.id))
    if (next !== widgets) onSave(next)
  }

  const patch = (next: WidgetInstance) => onSave(widgets.map((w) => (w.id === next.id ? next : w)))
  const remove = (id: string) => onSave(widgets.filter((w) => w.id !== id))
  const add = (type: WidgetType) => {
    const meta = WIDGET_META[type]
    if (meta !== undefined) onSave([...widgets, meta.create()])
  }

  const presentTypes = new Set(widgets.map((w) => w.type))

  return (
    <div className="dash-widgets">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="add-widget">
            + Widget
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="widget-menu">
          {(Object.entries(WIDGET_META) as [WidgetType, WidgetMeta][]).map(([type, meta]) => {
            const disabled = !meta.multiInstance && presentTypes.has(type)
            return (
              <DropdownMenuItem key={type} disabled={disabled} onSelect={() => add(type)}>
                {meta.title}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
          <div className="dash-grid">
            {widgets.map((instance) => (
              <SortableWidget
                key={instance.id}
                instance={instance}
                onChange={patch}
                onRemove={remove}
                onConfigure={onConfigure}
                renderWidget={renderWidget}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

function SortableWidget({
  instance,
  onChange,
  onRemove,
  onConfigure,
  renderWidget,
}: {
  instance: WidgetInstance
  onChange: (next: WidgetInstance) => void
  onRemove: (id: string) => void
  onConfigure?: (instance: WidgetInstance) => void
  renderWidget: (instance: WidgetInstance) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: instance.id })
  const meta = WIDGET_META[instance.type]
  return (
    <WidgetFrame
      instance={instance}
      title={meta?.title ?? instance.type}
      onChange={onChange}
      onRemove={onRemove}
      onConfigure={onConfigure !== undefined && (instance.type === 'github-prs' || instance.type === 'autopilot') ? () => onConfigure(instance) : undefined}
      dragHandleProps={{ ...attributes, ...listeners }}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {renderWidget(instance)}
    </WidgetFrame>
  )
}
