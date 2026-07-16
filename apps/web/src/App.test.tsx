import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatMessage, ProjectSummary, SessionSummary } from '@atelier/shared'
import type { Backend } from './api/backend'
import App from './App'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const project: ProjectSummary = { id: 'p1', path: '/Users/demo/workspace/atelier', color: 'cyan', sessionCount: 1 }

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
    registerProject: async (path) => ({ id: 'p2', path, color: 'magenta', sessionCount: 0 }),
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
  render(
    <QueryClientProvider client={queryClient}>
      <App backend={backend} />
    </QueryClientProvider>,
  )
  return { queryClient }
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

  // History with a tool call carrying a file → ChatView renders an IDE button.
  const toolMessage: ChatMessage = {
    role: 'tool',
    toolUseId: 't1',
    kind: 'Edit',
    summary: 'src/auth/refresh.ts',
    ok: true,
    file: 'src/auth/refresh.ts',
    line: 42,
    at: '2026-07-15T09:40:30.000Z',
  }

  test('an open-in-ide refusal ({ok:false}) surfaces its reason as a dismissible notice', async () => {
    const backend = fakeBackend({
      getMessages: async () => [toolMessage],
      openInIde: async () => ({ ok: false, reason: 'aucun IDE détecté' }),
    })
    renderApp(backend)

    fireEvent.click(await screen.findByText('Session un'))
    fireEvent.click(await screen.findByRole('button', { name: /ouvrir dans l/i }))

    const notice = await screen.findByText(/Impossible d’ouvrir dans l’IDE/)
    expect(notice.textContent).toContain('aucun IDE détecté')
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(screen.queryByText(/Impossible d’ouvrir dans l’IDE/)).toBeNull()
  })

  test('a rejected open-in-ide call is caught and surfaced, not an unhandled rejection', async () => {
    const backend = fakeBackend({
      getMessages: async () => [toolMessage],
      openInIde: async () => Promise.reject(new Error('POST /api/open-in-ide → 401')),
    })
    renderApp(backend)

    fireEvent.click(await screen.findByText('Session un'))
    fireEvent.click(await screen.findByRole('button', { name: /ouvrir dans l/i }))

    const notice = await screen.findByText(/Impossible d’ouvrir dans l’IDE/)
    expect(notice.textContent).toContain('POST /api/open-in-ide → 401')
  })
})

describe('App projects list resilience', () => {
  test('unregistering the OPEN project falls back to the first remaining one, and « + Session » targets it', async () => {
    const other: ProjectSummary = { id: 'p2', path: '/Users/demo/workspace/blog', color: 'magenta', sessionCount: 0 }
    let projects = [project, other]
    const draftTargets: string[] = []
    const backend = fakeBackend({
      listProjects: async () => projects,
      createDraft: async (projectId) => {
        draftTargets.push(projectId)
        return { ...session, id: 'd1', projectId, name: null, isDraft: true, messageCount: 0 }
      },
    })
    const { queryClient } = renderApp(backend)

    // Open project B, then unregister it server-side (what the settings dialog
    // does: DELETE then invalidate the shared ['projects'] key).
    fireEvent.click(await screen.findByText('blog'))
    projects = [project]
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
    })

    // The stale openProjectId must not shadow the fallback: A reads as open…
    await waitFor(() => expect(screen.getByText('atelier').className).toContain('open'))
    expect(screen.queryByText('blog')).toBeNull()
    // …and a new session is created against the fallback, never the dead id.
    fireEvent.click(screen.getByRole('button', { name: '+ Session' }))
    await waitFor(() => expect(draftTargets).toEqual(['p1']))
  })

  test('a failed background refetch keeps the rendered list — no retry-card clobber', async () => {
    let fail = false
    const backend = fakeBackend({
      listProjects: async () => {
        if (fail) throw new Error('GET /api/projects → 401')
        return [project]
      },
    })
    const { queryClient } = renderApp(backend)
    await screen.findByText('atelier')

    // E.g. the settings dialog refetching the shared ['projects'] key under
    // fixtures: the refetch fails but cached data exists — the list must stay.
    fail = true
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
    })
    // react-query batches observer notifications through setTimeout(0): flush
    // that macrotask so the error-status re-render (if any) lands before we assert.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(queryClient.getQueryState(['projects'])?.status).toBe('error') // the refetch really failed…
    expect(screen.getByText('atelier')).toBeTruthy() // …yet the cached list keeps rendering
    expect(screen.queryByText(/Impossible de charger les projets/)).toBeNull()
  })
})
