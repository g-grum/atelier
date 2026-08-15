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
    title: 'Plan limits',
    multiInstance: false,
    create: () => ({ id: crypto.randomUUID(), type: 'rate-limits', span: 2, height: 'M' }),
  },
  'modified-files': {
    title: 'Modified files — session',
    multiInstance: false,
    create: () => ({ id: crypto.randomUUID(), type: 'modified-files', span: 2, height: 'M' }),
  },
  'github-prs': {
    title: 'Pull Requests',
    multiInstance: true,
    // repo vide = à configurer (le widget affiche un état dédié au lieu d'interroger gh).
    create: () => ({
      id: crypto.randomUUID(),
      type: 'github-prs',
      span: 2,
      height: 'M',
      config: { repo: '', limit: 10 },
    }),
  },
  autopilot: {
    title: 'Autopilot',
    multiInstance: false,
    // projectId vide = à configurer (le bouton Lancer reste désactivé tant que la config n'est pas faite).
    create: () => ({ id: crypto.randomUUID(), type: 'autopilot', span: 2, height: 'M', config: { projectId: '', maxItems: 3 } }),
  },
  'session-visuals': {
    title: 'Session visuals',
    multiInstance: false,
    create: () => ({ id: crypto.randomUUID(), type: 'session-visuals', span: 2, height: 'M' }),
  },
  'dev-servers': {
    title: 'Dev servers',
    multiInstance: false,
    create: () => ({ id: crypto.randomUUID(), type: 'dev-servers', span: 2, height: 'M' }),
  },
}
