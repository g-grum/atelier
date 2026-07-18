import type { UsageEvent } from '@atelier/shared'
import { formatTokens } from './UsagePanel'

const FIVE_HOURS_MS = 5 * 3600_000
const SEVEN_DAYS_MS = 7 * 86400_000

export type UsageWindowTotals = { input: number; output: number; cache: number; total: number }

/** Rolls the recorded usage events into the 5-hour and 7-day windows (cache = read + creation). */
export function aggregateUsage(events: UsageEvent[], now: Date): { fiveHours: UsageWindowTotals; sevenDays: UsageWindowTotals } {
  const empty = (): UsageWindowTotals => ({ input: 0, output: 0, cache: 0, total: 0 })
  const fiveHours = empty()
  const sevenDays = empty()
  const nowMs = now.getTime()

  for (const event of events) {
    const age = nowMs - Date.parse(event.at)
    if (Number.isNaN(age) || age > SEVEN_DAYS_MS || age < 0) continue
    add(sevenDays, event)
    if (age <= FIVE_HOURS_MS) add(fiveHours, event)
  }
  return { fiveHours, sevenDays }
}

function add(totals: UsageWindowTotals, event: UsageEvent): void {
  totals.input += event.inputTokens
  totals.output += event.outputTokens
  totals.cache += event.cacheReadTokens + event.cacheCreationTokens
  totals.total += event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheCreationTokens
}

export type InFlightTokens = { input: number; output: number; cacheRead: number; cacheCreation: number }

export type GlobalUsagePanelProps = {
  /** GET /api/usage/history — every turn recorded by the server, all sessions and projects (7-day retention). */
  events: UsageEvent[]
  /** Live counters of the in-flight turn (StreamState.turnTokens) — counted in both windows since it is happening NOW. */
  inFlight?: InFlightTokens
}

/**
 * « Usage — global » card: tokens consumed by Atelier across ALL sessions,
 * rolled into the plan's two windows (5 h / 7 days). Complements the plan
 * gauges: the gauges say how full the account is, this says what Atelier
 * itself spent. Live: the in-flight turn's counters ride on top of the
 * recorded history and are replaced by the recorded event once the turn
 * settles. Honest-data policy — empty state until real numbers exist.
 */
export function GlobalUsagePanel({ events, inFlight }: GlobalUsagePanelProps) {
  const { fiveHours, sevenDays } = aggregateUsage(events, new Date())
  if (inFlight !== undefined) {
    addInFlight(fiveHours, inFlight)
    addInFlight(sevenDays, inFlight)
  }

  return (
    <section className="card" aria-label="Usage global">
      <h3>Usage — global</h3>
      {sevenDays.total === 0 ? (
        <p className="limits-empty">Aucun usage enregistré sur 7 jours.</p>
      ) : (
        <>
          <UsageWindowRow label="5 dernières heures" totals={fiveHours} />
          <UsageWindowRow label="7 derniers jours" totals={sevenDays} />
        </>
      )}
    </section>
  )
}

function addInFlight(totals: UsageWindowTotals, live: InFlightTokens): void {
  totals.input += live.input
  totals.output += live.output
  totals.cache += live.cacheRead + live.cacheCreation
  totals.total += live.input + live.output + live.cacheRead + live.cacheCreation
}

function UsageWindowRow({ label, totals }: { label: string; totals: UsageWindowTotals }) {
  return (
    <div className="usage-window">
      <div className="kv">
        <span>{label}</span>
        <b>{formatTokens(totals.total)}</b>
      </div>
      <div className="usage-breakdown">
        entrée {formatTokens(totals.input)} · sortie {formatTokens(totals.output)} · cache {formatTokens(totals.cache)}
      </div>
    </div>
  )
}
