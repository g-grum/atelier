import { arrayMove } from '@dnd-kit/sortable'
import type { WidgetInstance } from '@atelier/shared'

/**
 * Pure onDragEnd logic — unit-tested here so the DashboardGrid wiring stays a
 * thin, untestable-DnD-free shell. Returns the ORIGINAL array when nothing
 * moves (callers skip the PUT on referential equality).
 */
export function reorderWidgets(widgets: WidgetInstance[], activeId: string, overId: string): WidgetInstance[] {
  if (activeId === overId) return widgets
  const from = widgets.findIndex((w) => w.id === activeId)
  const to = widgets.findIndex((w) => w.id === overId)
  if (from === -1 || to === -1) return widgets
  return arrayMove(widgets, from, to)
}
