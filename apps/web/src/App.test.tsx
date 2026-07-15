import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Project, SessionSummary } from '@atelier/shared'
import type { Backend } from './api/backend'
import App from './App'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const project: Project = { id: 'p1', path: '/Users/demo/workspace/atelier', color: 'cyan' }

const session: SessionSummary = {
  id: 's1',
  projectId: 'p1',
  name: 'Session un',
  updatedAt: '2026-07-15T09:41:00.000Z',
  messageCount: 1,
  isDraft: false,
  model: 'claude-fable-5',
}

/** A no-op socket: these tests exercise REST failure paths, not the stream. */
const idleSocket = {
  on: () => () => {},
  onReconnect: () => () => {},
  send: () => {},
  close: () => {},
}

function fakeBackend(overrides: Partial<Backend> = {}): Backend {
  return {
    listProjects: async () => [project],
    registerProject: async (path) => ({ id: 'p2', path, color: 'magenta' }),
    listSessions: async () => [session],
    createDraft: async (projectId) => ({ ...session, id: 'd1', projectId, name: null, isDraft: true, messageCount: 0 }),
    getMessages: async () => [],
    patchSession: async () => {},
    deleteSession: async () => {},
    openInIde: async () => ({ ok: true }),
    createSocket: () => idleSocket,
    ...overrides,
  }
}

function renderApp(backend: Backend) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <App backend={backend} />
    </QueryClientProvider>,
  )
}

describe('App failure surfacing', () => {
  test('a failed projects fetch shows the sidebar error, never the register form', async () => {
    renderApp(fakeBackend({ listProjects: async () => Promise.reject(new Error('GET /api/projects → 401')) }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('GET /api/projects → 401')
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).toBeNull()
  })

  test('a failed session open shows a banner whose retry recovers the chat', async () => {
    let fail = true
    const backend = fakeBackend({
      getMessages: async () => {
        if (fail) throw new Error('GET /api/sessions/s1/messages → 500')
        return [{ role: 'user', text: 'Bonjour Claude', at: '2026-07-15T09:40:00.000Z' }]
      },
    })
    renderApp(backend)

    fireEvent.click(await screen.findByText('Session un'))
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('GET /api/sessions/s1/messages → 500')

    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    await screen.findByText('Bonjour Claude')
    expect(screen.queryByText(/Impossible de charger la session/)).toBeNull()
  })

  test('a failed rename surfaces a dismissible notice', async () => {
    const backend = fakeBackend({
      patchSession: async () => Promise.reject(new Error('PATCH /api/sessions/s1 → 500')),
    })
    renderApp(backend)

    fireEvent.click(await screen.findByText('Session un'))
    fireEvent.click(await screen.findByRole('button', { name: /renommer la session/i }))
    const input = screen.getByLabelText('Renommer la session')
    fireEvent.change(input, { target: { value: 'Nouveau nom' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const notice = await screen.findByText(/Échec du renommage/)
    expect(notice.textContent).toContain('PATCH /api/sessions/s1 → 500')
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(screen.queryByText(/Échec du renommage/)).toBeNull()
  })
})
