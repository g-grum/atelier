import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { GithubAccountChip } from './GithubAccountChip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

describe('GithubAccountChip', () => {
  test('renders the account login and exposes the repo as a tooltip', () => {
    render(<GithubAccountChip account={{ account: 'g-grum', repo: 'g-grum/atelier' }} />)
    const chip = screen.getByText('g-grum')
    expect(chip).not.toBeNull()
    expect(chip.getAttribute('title')).toBe('g-grum/atelier')
  })

  test('renders nothing while the account is unknown (null)', () => {
    const { container } = render(<GithubAccountChip account={null} />)
    expect(container.textContent).toBe('')
  })

  test('renders nothing when the project has no GitHub remote (account: null)', () => {
    const { container } = render(<GithubAccountChip account={{ account: null, repo: null }} />)
    expect(container.textContent).toBe('')
  })
})
