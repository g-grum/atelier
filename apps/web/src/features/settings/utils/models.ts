import type { Dictionary } from '@atelier/core/types'
import { MODELS } from '@atelier/shared'

/**
 * Display labels for the shared model ids — the single source for the topbar
 * chip (ModelSelector) and the settings panel's default-model select.
 * `Record<(typeof MODELS)[number], string>` keeps it exhaustive: adding a
 * model to MODELS without a label is a type error.
 */
export const MODEL_LABELS: Record<(typeof MODELS)[number], string> = {
  'claude-fable-5': 'Fable 5',
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-4-6': 'Sonnet 4.6',
}

/** Label for any persisted model id — one no longer in MODELS falls back to the raw id. */
export function modelLabel(model: string): string {
  return (MODEL_LABELS as Dictionary)[model] ?? model
}
