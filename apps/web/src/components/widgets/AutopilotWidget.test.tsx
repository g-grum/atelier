import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AutopilotState } from '@atelier/shared'
import { AutopilotWidget, type AutopilotWidgetApi } from './AutopilotWidget'

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
  test('run null : bouton « Lancer le backlog », désactivé sans projectId', async () => {
    renderWidget({ hubState: IDLE_STATE, projectId: '' })
    const button = await screen.findByRole('button', { name: 'Lancer le backlog' })
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  test('Lancer appelle startAutopilot avec projet et maxItems', async () => {
    const { api } = renderWidget({ hubState: IDLE_STATE })
    fireEvent.click(await screen.findByRole('button', { name: 'Lancer le backlog' }))
    await waitFor(() => expect(api.calls).toContain('start:p1:3'))
  })

  test('run actif : état + Arrêter ; les items s’affichent avec leur statut', async () => {
    const { api } = renderWidget({ hubState: RUN_STATE })
    expect(screen.getByText('run en cours')).toBeTruthy()
    expect(screen.getByText('#12 — Raccourci ⌘K')).toBeTruthy()
    expect(screen.getByText('en cours')).toBeTruthy()
    expect(screen.getByText('en attente')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Arrêter' }))
    await waitFor(() => expect(api.calls).toContain('stop'))
  })

  test('items terminaux : lien PR (navigateur système), lien session, erreur affichée, Nettoyer', async () => {
    const opened: string[] = []
    const selected: string[] = []
    const { api } = renderWidget({
      hubState: DONE_STATE,
      openUrl: (url) => opened.push(url),
      onOpenSession: (sessionId, projectId) => selected.push(`${sessionId}:${projectId}`),
    })
    expect(screen.getByText('timeout (30 min)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir la PR de l’issue #12 sur GitHub' }))
    expect(opened).toEqual(['https://github.com/o/r/pull/91'])
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir la session de l’issue #15' }))
    expect(selected).toEqual(['s-15:tp2'])
    fireEvent.click(screen.getByRole('button', { name: 'Nettoyer' }))
    await waitFor(() => expect(api.calls).toContain('cleanup'))
  })

  test('erreur d’action (start 409) affichée dans le widget', async () => {
    renderWidget({
      hubState: IDLE_STATE,
      api: makeApi({
        startAutopilot: async () => {
          throw new Error('un run autopilot est déjà en cours')
        },
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Lancer le backlog' }))
    await screen.findByText('un run autopilot est déjà en cours')
  })

  test('lastError du run précédent affichée quand idle', () => {
    renderWidget({ hubState: { run: null, items: [], lastError: 'aucune issue ouverte labellisée autopilot' } })
    expect(screen.getByText('aucune issue ouverte labellisée autopilot')).toBeTruthy()
  })

  test('sans hubState, fetch initial via getAutopilot (message vide)', async () => {
    const { api } = renderWidget({ hubState: null })
    await screen.findByText(/Aucun item/)
    expect(api.calls).toContain('get')
  })
})
