import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AutopilotState } from '@atelier/shared'
import { AutopilotWidget, type AutopilotWidgetApi } from '@/features/dashboard/components/autopilot-widget/AutopilotWidget'

afterEach(cleanup)

const IDLE_STATE: AutopilotState = { run: null, items: [] }

const RUN_STATE: AutopilotState = {
  run: { state: 'running', startedAt: '2026-08-05T10:00:00Z', maxItems: 3, projectId: 'p1' },
  items: [
    { issue: 12, title: 'Raccourci ⌘K', branch: 'autopilot/12', projectId: 'tp1', repoRoot: '/r', sessionId: 's-12', status: 'running', startedAt: '2026-08-05T10:00:00Z' },
    { issue: 15, title: 'Scroll composer', branch: 'autopilot/15', projectId: '', repoRoot: '/r', sessionId: '', status: 'queued' },
  ],
}

const DONE_STATE: AutopilotState = {
  run: null,
  items: [
    { issue: 12, title: 'Raccourci ⌘K', branch: 'autopilot/12', projectId: 'tp1', repoRoot: '/r', sessionId: 's-12', status: 'pr_opened', prUrl: 'https://github.com/o/r/pull/91' },
    { issue: 15, title: 'Scroll composer', branch: 'autopilot/15', projectId: 'tp2', repoRoot: '/r', sessionId: 's-15', status: 'failed', error: 'timeout (30 min)' },
  ],
}

const MERGED_STATE: AutopilotState = {
  run: null,
  items: [
    { issue: 21, title: 'Badge de statut', branch: 'autopilot/21', projectId: 'tp1', repoRoot: '/r', sessionId: 's-21', status: 'merged', prUrl: 'https://github.com/o/r/pull/99' },
  ],
}

const REVIEW_STATE: AutopilotState = {
  run: null,
  items: [
    { issue: 31, title: 'Review en cours', branch: 'autopilot/31', projectId: 'tp1', repoRoot: '/r', sessionId: 's-31', status: 'reviewing' },
    { issue: 32, title: 'Correction en cours', branch: 'autopilot/32', projectId: 'tp1', repoRoot: '/r', sessionId: 's-32', status: 'fixing' },
    { issue: 33, title: 'Merge en cours', branch: 'autopilot/33', projectId: 'tp1', repoRoot: '/r', sessionId: 's-33', status: 'merging' },
  ],
}

function makeApi(overrides: Partial<AutopilotWidgetApi> = {}): AutopilotWidgetApi & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    getAutopilot: async () => {
      calls.push('get')
      return IDLE_STATE
    },
    startAutopilot: async (projectId, maxItems) => {
      calls.push(`start:${projectId}:${maxItems}`)
    },
    stopAutopilot: async () => {
      calls.push('stop')
    },
    cleanupAutopilot: async () => {
      calls.push('cleanup')
    },
    ...overrides,
  }
}

function renderWidget(props: Partial<Parameters<typeof AutopilotWidget>[0]> = {}) {
  const api = makeApi()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={client}>
      <AutopilotWidget projectId="p1" maxItems={3} hubState={null} api={api} {...props} />
    </QueryClientProvider>,
  )
  return { api, ...utils }
}

describe('AutopilotWidget', () => {
  test('run null: "Run the backlog" button, disabled without projectId', async () => {
    renderWidget({ hubState: IDLE_STATE, projectId: '' })
    const button = await screen.findByRole('button', { name: 'Run the backlog' })
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  test('Run calls startAutopilot with project and maxItems', async () => {
    const { api } = renderWidget({ hubState: IDLE_STATE })
    fireEvent.click(await screen.findByRole('button', { name: 'Run the backlog' }))
    await waitFor(() => expect(api.calls).toContain('start:p1:3'))
  })

  test('active run: state + Stop; items render with their status', async () => {
    const { api } = renderWidget({ hubState: RUN_STATE })
    expect(screen.getByText('run in progress')).toBeTruthy()
    expect(screen.getByText('#12 — Raccourci ⌘K')).toBeTruthy()
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.getByText('queued')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(api.calls).toContain('stop'))
  })

  test('terminal items: PR link (system browser), session link, error shown, Clean up', async () => {
    const opened: string[] = []
    const selected: string[] = []
    const { api } = renderWidget({
      hubState: DONE_STATE,
      openUrl: (url) => opened.push(url),
      onOpenSession: (sessionId, projectId) => selected.push(`${sessionId}:${projectId}`),
    })
    expect(screen.getByText('timeout (30 min)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open the PR for issue #12 on GitHub' }))
    expect(opened).toEqual(['https://github.com/o/r/pull/91'])
    fireEvent.click(screen.getByRole('button', { name: 'Open the session for issue #15' }))
    expect(selected).toEqual(['s-15:tp2'])
    fireEvent.click(screen.getByRole('button', { name: 'Clean up' }))
    await waitFor(() => expect(api.calls).toContain('cleanup'))
  })

  test('merged item: "merged" label, green dot and terminal (Clean up visible)', async () => {
    const { api } = renderWidget({ hubState: MERGED_STATE })
    expect(screen.getByText('merged')).toBeTruthy()
    expect(document.querySelector('.pr-dot.merged')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clean up' }))
    await waitFor(() => expect(api.calls).toContain('cleanup'))
  })

  test('review/fixing/merging states: dedicated labels, non-terminal (no Clean up)', () => {
    renderWidget({ hubState: REVIEW_STATE })
    expect(screen.getByText('in review')).toBeTruthy()
    expect(screen.getByText('fixing')).toBeTruthy()
    expect(screen.getByText('merging')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clean up' })).toBeNull()
  })

  test('open PR not merged: explicit label and dot distinct from merged', () => {
    renderWidget({ hubState: DONE_STATE })
    expect(screen.getByText('PR opened (not merged)')).toBeTruthy()
    expect(document.querySelector('.pr-dot.merged')).toBeNull()
    expect(document.querySelector('.pr-dot.open')).toBeTruthy()
    expect(document.querySelector('.pr-dot.closed')).toBeTruthy()
  })

  test('action error (start 409) shown inside the widget', async () => {
    renderWidget({
      hubState: IDLE_STATE,
      api: makeApi({
        startAutopilot: async () => {
          throw new Error('an autopilot run is already in progress')
        },
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Run the backlog' }))
    await screen.findByText('an autopilot run is already in progress')
  })

  test('lastError from the previous run shown when idle', () => {
    renderWidget({ hubState: { run: null, items: [], lastError: 'no open issues labeled autopilot' } })
    expect(screen.getByText('no open issues labeled autopilot')).toBeTruthy()
  })

  test('without hubState, initial fetch via getAutopilot (empty message)', async () => {
    const { api } = renderWidget({ hubState: null })
    await screen.findByText(/No items/)
    expect(api.calls).toContain('get')
  })
})
