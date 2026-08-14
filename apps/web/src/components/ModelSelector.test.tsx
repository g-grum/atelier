import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionSummary } from '@atelier/shared'
import { ModelSelector, type ModelSelectorApi } from './ModelSelector'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const session: SessionSummary = {
  id: 's1',
  projectId: 'p1',
  name: 'Session un',
  updatedAt: '2026-07-15T09:41:00.000Z',
  messageCount: 1,
  isDraft: false,
  model: 'claude-fable-5',
  permissionMode: 'default',
}

function renderSelector(target: SessionSummary | null = session, overrides: Partial<ModelSelectorApi> = {}) {
  const patches: { sessionId: string; patch: { name?: string; model?: string } }[] = []
  const toasts: string[] = []
  const api: ModelSelectorApi = {
    patchSession: async (sessionId, patch) => {
      patches.push({ sessionId, patch })
    },
    ...overrides,
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  // Seed the cache so invalidation is observable through getQueryState().
  queryClient.setQueryData(['sessions', 'p1'], [session])
  render(
    <QueryClientProvider client={queryClient}>
      <ModelSelector session={target} api={api} toastFailure={(message) => void toasts.push(message)} />
    </QueryClientProvider>,
  )
  return { patches, toasts, queryClient }
}

function openMenu(): HTMLElement {
  const chip = screen.getByRole('button', { name: /change model/i })
  // Radix triggers open on pointerdown (not click) or on Enter/Space keydown.
  fireEvent.keyDown(chip, { key: 'Enter' })
  return chip
}

describe('ModelSelector', () => {
  test('the chip shows the active session model label', () => {
    renderSelector()
    const chip = screen.getByRole('button', { name: /change model/i })
    expect(chip.textContent).toContain('Fable 5')
  })

  test('no session → no chip', () => {
    renderSelector(null)
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('opening lists every model with the current one checked, plus the next-turn hint', async () => {
    renderSelector()
    openMenu()

    const current = await screen.findByRole('menuitemradio', { name: 'Fable 5' })
    expect(current.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Opus 4.8' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('menuitemradio', { name: 'Sonnet 4.6' }).getAttribute('aria-checked')).toBe('false')
    screen.getByText('Applies from the next turn.')
  })

  test('selecting a model PATCHes { model } for the session and invalidates the sessions list', async () => {
    const { patches, toasts, queryClient } = renderSelector()
    openMenu()

    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Opus 4.8' }))
    await waitFor(() => expect(patches).toEqual([{ sessionId: 's1', patch: { model: 'claude-opus-4-8' } }]))
    await waitFor(() => expect(queryClient.getQueryState(['sessions', 'p1'])?.isInvalidated).toBe(true))
    expect(toasts).toEqual([])
  })

  test('re-selecting the current model is a no-op (no PATCH)', async () => {
    const { patches } = renderSelector()
    openMenu()

    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Fable 5' }))
    await waitFor(() => expect(screen.queryByRole('menuitemradio')).toBeNull()) // menu closed
    expect(patches).toEqual([])
  })

  test('a model no longer in MODELS stays visible and checked, not silently remapped', async () => {
    renderSelector({ ...session, model: 'claude-legacy-1' })
    expect(screen.getByRole('button', { name: /change model/i }).textContent).toContain('claude-legacy-1')
    openMenu()

    const legacy = await screen.findByRole('menuitemradio', { name: 'claude-legacy-1' })
    expect(legacy.getAttribute('aria-checked')).toBe('true')
  })

  test('a rejected PATCH surfaces a toast, not an unhandled rejection', async () => {
    const { toasts } = renderSelector(session, {
      patchSession: async () => Promise.reject(new Error('PATCH /api/sessions/s1 → 500')),
    })
    openMenu()

    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Opus 4.8' }))
    await waitFor(() => expect(toasts).toEqual([expect.stringContaining('PATCH /api/sessions/s1 → 500')]))
    expect(toasts[0]).toContain('Could not change the model')
  })
})
