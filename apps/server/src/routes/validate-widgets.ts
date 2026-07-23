import { REPO_PATTERN, SINGLETON_WIDGET_TYPES, type WidgetInstance, type WidgetType } from '@atelier/shared'

const TYPES: ReadonlySet<string> = new Set<WidgetType>(['github-prs', 'rate-limits', 'modified-files'])
const HEIGHTS: ReadonlySet<string> = new Set(['S', 'M', 'L'])
const SINGLETONS: ReadonlySet<string> = new Set(SINGLETON_WIDGET_TYPES)

/**
 * Validates the PUT /api/widgets body. Returns a CLEAN copy (unknown keys
 * stripped — what we persist is exactly what we validated), or a French
 * error message for the 400 response.
 */
export function validateWidgets(value: unknown): { widgets: WidgetInstance[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'requête invalide : tableau de widgets attendu' }
  const widgets: WidgetInstance[] = []
  const ids = new Set<string>()
  const singletons = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { error: 'requête invalide : chaque widget doit être un objet' }
    }
    const w = entry as Record<string, unknown>
    if (typeof w.id !== 'string' || w.id.length === 0) return { error: 'requête invalide : « id » est requis' }
    if (ids.has(w.id)) return { error: `requête invalide : id dupliqué « ${w.id} »` }
    ids.add(w.id)
    if (typeof w.type !== 'string' || !TYPES.has(w.type)) return { error: `requête invalide : type inconnu « ${String(w.type)} »` }
    if (w.span !== 1 && w.span !== 2) return { error: 'requête invalide : « span » doit être 1 ou 2' }
    if (typeof w.height !== 'string' || !HEIGHTS.has(w.height)) return { error: 'requête invalide : « height » doit être S, M ou L' }
    if (SINGLETONS.has(w.type)) {
      if (singletons.has(w.type)) return { error: `requête invalide : « ${w.type} » ne peut apparaître qu’une fois` }
      singletons.add(w.type)
    }
    const clean: WidgetInstance = { id: w.id, type: w.type as WidgetType, span: w.span, height: w.height as WidgetInstance['height'] }
    if (w.type === 'github-prs') {
      if (typeof w.config !== 'object' || w.config === null || Array.isArray(w.config)) {
        return { error: 'requête invalide : « config » (avec repo) est requis pour github-prs' }
      }
      const config = w.config as Record<string, unknown>
      if (typeof config.repo !== 'string' || !REPO_PATTERN.test(config.repo)) {
        return { error: 'requête invalide : « config.repo » doit être de la forme owner/repo' }
      }
      if (config.limit !== undefined && (!Number.isInteger(config.limit) || (config.limit as number) < 1 || (config.limit as number) > 30)) {
        return { error: 'requête invalide : « config.limit » doit être un entier entre 1 et 30' }
      }
      clean.config = { repo: config.repo, ...(config.limit !== undefined ? { limit: config.limit as number } : {}) }
    } else {
      if (w.config !== undefined) return { error: `requête invalide : « config » n’est pas accepté pour ${w.type}` }
    }
    widgets.push(clean)
  }
  return { widgets }
}
