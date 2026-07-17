import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import type { RateLimitSnapshot } from '@atelier/shared'
import { formatReset, RateLimitsPanel } from './RateLimitsPanel'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const fiveHour: RateLimitSnapshot = {
  window: 'five_hour',
  utilization: 34,
  status: 'allowed',
  resetsAt: '2026-07-17T16:00:00.000Z',
  recordedAt: '2026-07-17T12:00:00.000Z',
}

const sevenDay: RateLimitSnapshot = {
  window: 'seven_day',
  utilization: 92,
  status: 'allowed_warning',
  resetsAt: '2026-07-24T00:00:00.000Z',
  recordedAt: '2026-07-17T12:00:00.000Z',
}

describe('RateLimitsPanel', () => {
  test('renders one gauge per window — label, percent, and a bar sized to the utilization', () => {
    const { container } = render(<RateLimitsPanel limits={[sevenDay, fiveHour]} />)

    expect(screen.getByText('Session (5 h)')).toBeTruthy()
    expect(screen.getByText('34 %')).toBeTruthy()
    expect(screen.getByText('Semaine — tous modèles')).toBeTruthy()
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
    expect(screen.getByText(/Aucune donnée/)).toBeTruthy()
  })
})

describe('formatReset', () => {
  test('same day → time only; another day → weekday + time', () => {
    const now = new Date('2026-07-17T12:00:00.000Z')
    expect(formatReset('2026-07-17T16:00:00.000Z', now)).toBe(`réinit. ${new Date('2026-07-17T16:00:00.000Z').toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`)
    const other = formatReset('2026-07-24T00:00:00.000Z', now)
    expect(other.startsWith('réinit. ')).toBe(true)
    expect(other.length).toBeGreaterThan('réinit. 00:00'.length) // carries the day part
  })
})
