import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import type { UsageEvent } from '@atelier/shared'
import { aggregateUsage, GlobalUsagePanel } from './GlobalUsagePanel'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const NOW = new Date('2026-07-17T12:00:00.000Z')

function event(at: string, tokens: Partial<Omit<UsageEvent, 'at'>> = {}): UsageEvent {
  return { at, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, ...tokens }
}

describe('aggregateUsage', () => {
  test('splits the history into a 5-hour window and a 7-day window', () => {
    const events = [
      event('2026-07-17T11:00:00.000Z', { inputTokens: 100, outputTokens: 10 }), // in both windows
      event('2026-07-17T05:00:00.000Z', { inputTokens: 1000, cacheReadTokens: 500 }), // 7 h ago — weekly only
      event('2026-07-11T11:00:00.000Z', { outputTokens: 7 }), // 6 days ago — weekly only
    ]
    const { fiveHours, sevenDays } = aggregateUsage(events, NOW)

    expect(fiveHours).toEqual({ input: 100, output: 10, cache: 0, total: 110 })
    expect(sevenDays).toEqual({ input: 1100, output: 17, cache: 500, total: 1617 })
  })

  test('events older than 7 days are ignored (belt over the server-side pruning)', () => {
    const { sevenDays } = aggregateUsage([event('2026-07-01T00:00:00.000Z', { inputTokens: 999 })], NOW)
    expect(sevenDays.total).toBe(0)
  })
})

describe('GlobalUsagePanel', () => {
  test('shows both windows with formatted totals and the in/out/cache breakdown', () => {
    render(
      <GlobalUsagePanel
        events={[
          event(new Date(Date.now() - 60_000).toISOString(), { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 500 }),
          event(new Date(Date.now() - 6 * 3600_000).toISOString(), { inputTokens: 1_000_000 }),
        ]}
      />,
    )
    expect(screen.getByText('Usage — global')).toBeTruthy()
    expect(screen.getByText('5 dernières heures')).toBeTruthy()
    expect(screen.getByText('2 k')).toBeTruthy() // 2000 tokens in the 5h window
    expect(screen.getByText('7 derniers jours')).toBeTruthy()
    expect(screen.getAllByText('1 M').length).toBeGreaterThan(0) // 1 002 000 weekly total (breakdown may repeat it)
  })

  test('no recorded usage → honest empty state', () => {
    render(<GlobalUsagePanel events={[]} />)
    expect(screen.getByText(/Aucun usage enregistré/)).toBeTruthy()
  })
})
