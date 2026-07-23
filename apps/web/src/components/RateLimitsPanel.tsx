import type { RateLimitSnapshot, RateLimitWindow } from '@atelier/shared'

/** Fixed display order + French labels — mirrors the claude.ai/usage page. */
const WINDOWS: { window: RateLimitWindow; label: string }[] = [
  { window: 'five_hour', label: 'Session (5 h)' },
  { window: 'seven_day', label: 'Semaine — tous modèles' },
  { window: 'seven_day_opus', label: 'Semaine — Opus' },
  { window: 'seven_day_sonnet', label: 'Semaine — Sonnet' },
  { window: 'seven_day_overage_included', label: 'Semaine — dépassement inclus' },
  { window: 'overage', label: 'Dépassement' },
]

/** « réinit. 16:00 » same day, « réinit. jeu. 24/07 16:00 » otherwise (fr-FR, local time). */
export function formatReset(resetsAt: string, now: Date): string {
  const reset = new Date(resetsAt)
  const time = reset.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const sameDay = reset.toDateString() === now.toDateString()
  if (sameDay) return `réinit. ${time}`
  const day = reset.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })
  return `réinit. ${day} ${time}`
}

export type RateLimitsPanelProps = {
  /** Last-known snapshot per window — REST baseline + live rate_limit events. */
  limits: RateLimitSnapshot[]
}

/**
 * « Limites du plan » card (right panel) — the claude.ai/usage gauges, fed by
 * REAL SDK rate_limit data. Honest-data policy: no gauge until a turn has
 * reported one. Warn styling is red (amber stays reserved for permissions).
 */
export function RateLimitsPanel({ limits }: RateLimitsPanelProps) {
  const byWindow = new Map(limits.map((limit) => [limit.window, limit]))
  const rows = WINDOWS.flatMap(({ window, label }) => {
    const limit = byWindow.get(window)
    return limit === undefined ? [] : [{ label, limit }]
  })
  const now = new Date()

  return (
    <section className="card" aria-label="Limites du plan">
      {rows.length === 0 ? (
        <p className="limits-empty">Aucune donnée de limite pour l’instant — elles arrivent avec le premier tour.</p>
      ) : (
        rows.map(({ label, limit }) => {
          // A snapshot whose window already reset describes a FINISHED window —
          // showing its percent as current would lie (the real number is
          // unknown until the next turn reports fresh data).
          const expired = limit.resetsAt !== undefined && Date.parse(limit.resetsAt) < now.getTime()
          if (expired) {
            return (
              <div key={limit.window} className="limit-row stale">
                <div className="kv">
                  <span>{label}</span>
                </div>
                <div className="limit-reset">fenêtre réinitialisée — en attente du prochain tour</div>
              </div>
            )
          }
          const warn = limit.status !== 'allowed' || limit.utilization >= 90
          return (
            <div key={limit.window} className="limit-row">
              <div className="kv">
                <span>{label}</span>
                <b>{limit.utilization}&nbsp;%</b>
              </div>
              <div className={`gauge${warn ? ' warn' : ''}`}>
                <i style={{ width: `${limit.utilization}%` }} />
              </div>
              {limit.resetsAt !== undefined && <div className="limit-reset">{formatReset(limit.resetsAt, now)}</div>}
            </div>
          )
        })
      )}
    </section>
  )
}
