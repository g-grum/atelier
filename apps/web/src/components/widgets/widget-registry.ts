import type { WidgetInstance, WidgetType } from '@atelier/shared'

export type WidgetMeta = {
  /** Heading shown by WidgetFrame (the frame owns the h3 — panels drop theirs). */
  title: string
  /** false → greyed in the palette once present. */
  multiInstance: boolean
  /** Fresh instance for « + Widget ». */
  create: () => WidgetInstance
}

/** Chunk 2 registry — github-prs joins in chunk 3 (Task 15). */
export const WIDGET_META: Partial<Record<WidgetType, WidgetMeta>> = {
  'rate-limits': {
    title: 'Limites du plan',
    multiInstance: false,
    create: () => ({ id: crypto.randomUUID(), type: 'rate-limits', span: 2, height: 'M' }),
  },
  'modified-files': {
    title: 'Fichiers modifiés — session',
    multiInstance: false,
    create: () => ({ id: crypto.randomUUID(), type: 'modified-files', span: 2, height: 'M' }),
  },
}
