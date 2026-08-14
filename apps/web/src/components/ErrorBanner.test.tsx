import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { fixtureErrorTurn } from '../state/fixtures'
import { initialState, reduce } from '../state/stream-reducer'
import { ErrorBanner } from './ErrorBanner'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

describe('ErrorBanner', () => {
  test('usage-limit fixture turn (real reducer) → reset time in local HH:MM, not the machine reason', () => {
    const state = fixtureErrorTurn.reduce(reduce, initialState())
    expect(state.status).toBe('error')
    render(<ErrorBanner status={state.status} error={state.error} />)

    const at = new Date(state.error!.resetAt!)
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    const banner = screen.getByRole('alert')
    expect(banner.textContent).toBe(`Usage limit reached — resets at ${hhmm}`)
    expect(banner.textContent).not.toContain('usage_limit')
  })

  test('usage_limit without resetAt → « Usage limit reached » (time-less), never the raw slug', () => {
    const state = reduce(initialState(), {
      type: 'status',
      sessionId: 'ses-1',
      state: 'error',
      error: { reason: 'usage_limit' },
    })
    render(<ErrorBanner status={state.status} error={state.error} />)
    const banner = screen.getByRole('alert')
    expect(banner.textContent).toBe('Usage limit reached')
    expect(banner.textContent).not.toContain('usage_limit')
  })

  test('error without resetAt → the reason text', () => {
    const state = reduce(initialState(), {
      type: 'status',
      sessionId: 'ses-1',
      state: 'error',
      error: { reason: 'Le processus claude s’est arrêté (code 1)' },
    })
    render(<ErrorBanner status={state.status} error={state.error} />)
    expect(screen.getByRole('alert').textContent).toBe('Le processus claude s’est arrêté (code 1)')
  })

  test('renders nothing when there is no error (idle or streaming)', () => {
    const idle = initialState()
    const { unmount } = render(<ErrorBanner status={idle.status} error={idle.error} />)
    expect(screen.queryByRole('alert')).toBeNull()
    unmount()

    const streaming = reduce(initialState(), { type: 'assistant_delta', sessionId: 'ses-1', text: 'Bonjour' })
    render(<ErrorBanner status={streaming.status} error={streaming.error} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
