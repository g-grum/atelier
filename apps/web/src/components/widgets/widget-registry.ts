import type { WidgetInstance, WidgetType } from '@atelier/shared'

export type WidgetMeta = {
  /** Heading shown by WidgetFrame (the frame owns the h3 — panels drop theirs). */
  title: string
  /** false → greyed in the palette once present. */
  multiInstance: boolean
  /** Fresh instance for « + Widget ». */
  create: () => WidgetInstance
}

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
  'github-prs': {
    title: 'Pull Requests',
    multiInstance: true,
    create: () => ({
      id: crypto.randomUUID(),
      type: 'github-prs',
      span: 2,
      height: 'M',
      config: { repo: 'acme-corp/demoapp-frontend', limit: 10 },
    }),
  },
}
