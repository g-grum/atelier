import type { StreamState } from '../state/stream-reducer'

/**
 * Compact French token count: « 486 », « 2,4 k », « 128 k », « 1,3 M » —
 * decimal comma, no-break space before the unit. One decimal below 10 of a
 * unit, whole numbers above; a count that would round to « 1000 k » promotes
 * to « 1 M ».
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 999_500) return `${scaled(count / 1000)}\u00A0k`
  return `${scaled(count / 1_000_000)}\u00A0M`
}

function scaled(value: number): string {
  const rounded = value < 9.95 ? Math.round(value * 10) / 10 : Math.round(value)
  return String(rounded).replace('.', ',')
}

export type UsagePanelProps = {
  /** StreamState.sessionTokens — accumulated by the reducer from usage events. */
  tokens: StreamState['sessionTokens']
}

/**
 * « Usage — session » card of the right panel (mockup .card / .kv recipes):
 * the LIVE session token counters only. The 5-hour/weekly gauges and the
 * forecast are v0.2 — spec's honest data policy: real numbers or nothing.
 */
export function UsagePanel({ tokens }: UsagePanelProps) {
  const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation
  return (
    <section className="card" aria-label="Usage de la session">
      <h3>Usage — session</h3>
      <div className="kv">
        <span>Entrée</span>
        <b>{formatTokens(tokens.input)}</b>
      </div>
      <div className="kv">
        <span>Sortie</span>
        <b>{formatTokens(tokens.output)}</b>
      </div>
      <div className="kv">
        <span>Cache (lecture)</span>
        <b>{formatTokens(tokens.cacheRead)}</b>
      </div>
      <div className="kv">
        <span>Cache (écriture)</span>
        <b>{formatTokens(tokens.cacheCreation)}</b>
      </div>
      <div className="kv total">
        <span>Total</span>
        <b>{formatTokens(total)}</b>
      </div>
    </section>
  )
}
