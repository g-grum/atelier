import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PrSummary } from '@atelier/shared'
import { formatAge, PrListWidget } from './PrListWidget'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const prs: PrSummary[] = [
  { number: 1, title: 'Open pending', url: 'https://x/1', author: 'a', state: 'open', updatedAt: new Date().toISOString(), branch: 'b1', ci: 'pending', review: 'required' },
  { number: 2, title: 'Merged green', url: 'https://x/2', author: 'b', state: 'merged', updatedAt: new Date().toISOString(), branch: 'b2', ci: 'passed', review: 'approved' },
]

function renderWidget(impl: () => Promise<PrSummary[]>, { repo = 'o/r', onConfigure }: { repo?: string; onConfigure?: () => void } = {}) {
  const opened: string[] = []
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PrListWidget repo={repo} limit={10} api={{ getGithubPrs: impl }} openUrl={(url) => opened.push(url)} onConfigure={onConfigure} />
    </QueryClientProvider>,
  )
  return { opened }
}

describe('PrListWidget', () => {
  test('renders one compact row per PR (title, state dot, age)', async () => {
    renderWidget(async () => prs)
    await waitFor(() => screen.getByText('Open pending'))
    screen.getByText('Merged green')
    expect(document.querySelectorAll('.pr-dot')).toHaveLength(2)
  })

  test('row click expands inline details; second click collapses', async () => {
    renderWidget(async () => prs)
    await waitFor(() => screen.getByText('Open pending'))
    fireEvent.click(screen.getByRole('button', { name: /Open pending/ }))
    screen.getByText('#1')
    screen.getByText('b1')
    screen.getByText(/CI running/)
    screen.getByText(/review required/i)
    screen.getByRole('button', { name: /Open on GitHub/ }) // second ↗ inside the expansion (spec)
    fireEvent.click(screen.getByRole('button', { name: /Open pending/ }))
    expect(screen.queryByText('#1')).toBeNull()
  })

  test('↗ opens the PR url without toggling the row', async () => {
    const { opened } = renderWidget(async () => prs)
    await waitFor(() => screen.getByText('Open pending'))
    fireEvent.click(screen.getByRole('button', { name: 'Open PR #1 on GitHub' }))
    expect(opened).toEqual(['https://x/1'])
    expect(screen.queryByText('b1')).toBeNull()
  })

  test('error state shows the server message and retries on click', async () => {
    let failures = 1
    renderWidget(async () => {
      if (failures-- > 0) throw new Error('gh is not authenticated for "alice-dev"')
      return prs
    })
    await waitFor(() => screen.getByText(/authenticated/))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => screen.getByText('Open pending'))
  })

  test('empty state', async () => {
    renderWidget(async () => [])
    await waitFor(() => screen.getByText('No recent PRs'))
  })

  test('empty repo: "needs configuration" state without a gh call, button opens the config', () => {
    const calls: number[] = []
    const configured: boolean[] = []
    renderWidget(
      async () => {
        calls.push(1)
        return prs
      },
      { repo: '', onConfigure: () => configured.push(true) },
    )
    screen.getByText(/needs configuration/i)
    fireEvent.click(screen.getByRole('button', { name: 'Configure…' }))
    expect(configured).toEqual([true])
    expect(calls).toEqual([]) // no gh request until the repo is set
  })
})

describe('formatAge', () => {
  test('minutes, hours, days', () => {
    const now = new Date('2026-07-21T12:00:00Z')
    expect(formatAge('2026-07-21T11:58:00Z', now)).toBe('2 min')
    expect(formatAge('2026-07-21T09:00:00Z', now)).toBe('3 h')
    expect(formatAge('2026-07-18T09:00:00Z', now)).toBe('3 d')
  })
})
