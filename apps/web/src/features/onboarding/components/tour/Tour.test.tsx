import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tour } from '@/features/onboarding/components/tour/Tour'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  document.querySelectorAll('[data-test-anchor]').forEach((el) => el.remove())
})

/** Mounts fake anchor elements the steps can attach to. */
function mountAnchors(selectors: string[]) {
  for (const selector of selectors) {
    const el = document.createElement('div')
    if (selector.startsWith('.')) el.className = selector.slice(1)
    else el.setAttribute('data-tour', 'settings')
    el.setAttribute('data-test-anchor', '')
    document.body.appendChild(el)
  }
}

const ALL_ANCHORS = ['.sidebar', '.composer', '.dash', '[data-tour="settings"]']

describe('Tour', () => {
  test('walks through the steps with Next and finishes with Done', () => {
    mountAnchors(ALL_ANCHORS)
    let finished = 0
    render(<Tour onFinish={() => finished++} />)
    expect(screen.getByText('Projects & sessions')).toBeTruthy()
    expect(screen.getByText('1/4')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Talk to Claude')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('4/4')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(finished).toBe(1)
  })

  test('Skip finishes immediately', () => {
    mountAnchors(ALL_ANCHORS)
    let finished = 0
    render(<Tour onFinish={() => finished++} />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(finished).toBe(1)
  })

  test('Escape finishes the tour like Skip', () => {
    mountAnchors(ALL_ANCHORS)
    let finished = 0
    render(<Tour onFinish={() => finished++} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(finished).toBe(1)
  })

  test('a missing anchor skips its step instead of crashing', () => {
    mountAnchors(['.sidebar', '.dash', '[data-tour="settings"]']) // no .composer
    render(<Tour onFinish={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    // Step 2 (.composer) is skipped — the tour lands on the dashboard step.
    expect(screen.getByText('Dashboard')).toBeTruthy()
  })

  test('all anchors missing finishes immediately without rendering', () => {
    let finished = 0
    render(<Tour onFinish={() => finished++} />)
    expect(finished).toBe(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
