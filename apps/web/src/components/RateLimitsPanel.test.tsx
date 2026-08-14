import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import type { RateLimitSnapshot } from '@atelier/shared'
import { formatReset, RateLimitsPanel } from './RateLimitsPanel'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

// resetsAt in the far future — these snapshots must read as FRESH (the
// staleness tests below cover the expired path explicitly).
const fiveHour: RateLimitSnapshot = {
  window: 'five_hour',
  utilization: 34,
  status: 'allowed',
  resetsAt: '2099-07-17T16:00:00.000Z',
  recordedAt: '2026-07-17T12:00:00.000Z',
}

const sevenDay: RateLimitSnapshot = {
  window: 'seven_day',
  utilization: 92,
  status: 'allowed_warning',
  resetsAt: '2099-07-24T00:00:00.000Z',
  recordedAt: '2026-07-17T12:00:00.000Z',
}

describe('RateLimitsPanel', () => {
  test('renders one gauge per window — label, percent, and a bar sized to the utilization', () => {
    const { container } = render(<RateLimitsPanel limits={[sevenDay, fiveHour]} />)

    expect(screen.getByText('Session (5 hr)')).toBeTruthy()
    expect(screen.getByText('34 %')).toBeTruthy()
    expect(screen.getByText('Week — all models')).toBeTruthy()
    expect(screen.getByText('92 %')).toBeTruthy()

    const bars = container.querySelectorAll('.gauge > i')
    expect(bars).toHaveLength(2)
    // Fixed display order: five_hour first regardless of input order.
    expect((bars[0] as HTMLElement).style.width).toBe('34%')
    expect((bars[1] as HTMLElement).style.width).toBe('92%')
  })

  test('a warning/rejected or ≥90% window gets the warn styling', () => {
    const { container } = render(<RateLimitsPanel limits={[fiveHour, sevenDay]} />)
    const rows = container.querySelectorAll('.gauge')
    expect((rows[0] as HTMLElement).className).not.toContain('warn')
    expect((rows[1] as HTMLElement).className).toContain('warn')
  })

  test('no data → honest empty state, no fake gauges', () => {
    render(<RateLimitsPanel limits={[]} />)
    expect(screen.getByText(/No limit data/)).toBeTruthy()
  })
})

describe('RateLimitsPanel staleness', () => {
  test('a window whose reset time has passed is shown as expired — never a stale percent presented as current', () => {
    const { container } = render(
      <RateLimitsPanel
        limits={[
          { window: 'five_hour', utilization: 98, status: 'allowed_warning', resetsAt: '2020-01-01T00:00:00.000Z', recordedAt: '2020-01-01T00:00:00.000Z' },
          fiveHourFresh,
        ]}
      />,
    )
    // The expired snapshot loses its bar/percent claim and says so.
    expect(screen.getByText(/window reset/i)).toBeTruthy()
    expect(screen.queryByText('98 %')).toBeNull()
    // The fresh seven_day gauge still renders normally.
    expect(screen.getByText('61 %')).toBeTruthy()
    expect(container.querySelectorAll('.gauge')).toHaveLength(1)
  })
})

const fiveHourFresh: RateLimitSnapshot = {
  window: 'seven_day',
  utilization: 61,
  status: 'allowed',
  resetsAt: '2099-01-01T00:00:00.000Z',
  recordedAt: '2026-07-17T12:00:00.000Z',
}

describe('formatReset', () => {
  test('same day → time only; another day → weekday + time', () => {
    const now = new Date('2026-07-17T12:00:00.000Z')
    expect(formatReset('2026-07-17T16:00:00.000Z', now)).toBe(`resets ${new Date('2026-07-17T16:00:00.000Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`)
    const other = formatReset('2026-07-24T00:00:00.000Z', now)
    expect(other.startsWith('resets ')).toBe(true)
    expect(other.length).toBeGreaterThan(`resets ${new Date('2026-07-24T00:00:00.000Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`.length) // carries the day part
  })
})
