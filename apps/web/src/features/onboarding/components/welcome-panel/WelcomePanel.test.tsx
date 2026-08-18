import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WelcomePanel } from '@/features/onboarding/components/welcome-panel/WelcomePanel'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

describe('WelcomePanel', () => {
  test('renders the three getting-started steps', () => {
    render(<WelcomePanel onGetStarted={() => {}} />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toContain('Register a project')
    expect(items[1].textContent).toContain('Start a session')
    expect(items[2].textContent).toContain('Watch the dashboard')
  })

  test('the primary button fires onGetStarted', () => {
    let called = 0
    render(<WelcomePanel onGetStarted={() => called++} />)
    fireEvent.click(screen.getByRole('button', { name: /register your first project/i }))
    expect(called).toBe(1)
  })
})
