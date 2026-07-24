import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ChatMessage, ProjectSummary, ServerEvent, SessionSummary } from '@atelier/shared'
import { DEFAULT_WIDGETS } from '@atelier/shared'
import type { Backend } from './api/backend'
import App from './App'
import currentVersion from '../../../version.json'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  // Launch-restore persists the last session — a leak between tests would make
  // one test's selection another test's restored session.
  localStorage.clear()
})

const project: ProjectSummary = { id: 'p1', path: '/Users/demo/workspace/atelier', color: 'cyan', sessionCount: 1 }

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
    getVersion: async () => currentVersion,
    getUsageLimits: async () => [],
    getWidgets: async () => [...DEFAULT_WIDGETS],
    putWidgets: async (next) => next,
    getGithubPrs: async () => [],
    // No `theme` key → the boot resync applies dark (spec: clé absente = dark).
    getPreferences: async () => ({ ide: 'webstorm', defaultModel: 'claude-fable-5', windowBudgetTokens: 2_000_000, weeklyBudgetTokens: 12_000_000, githubUser: 'alice-dev' }),
    patchPreferences: async (patch) => ({ ide: 'webstorm', defaultModel: 'claude-fable-5', windowBudgetTokens: 2_000_000, weeklyBudgetTokens: 12_000_000, githubUser: 'alice-dev', ...patch }),
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

    // the launch restore opens s1 on its own — the failure surfaces unclicked
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

    // s1 is auto-opened by the launch restore
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

    // s1 is auto-opened by the launch restore — its history renders the IDE button
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

    fireEvent.click(await screen.findByRole('button', { name: /ouvrir dans l/i }))

    const notice = await screen.findByText(/Impossible d’ouvrir dans l’IDE/)
    expect(notice.textContent).toContain('POST /api/open-in-ide → 401')
  })
})

describe('App per-session permissions gate', () => {
  test('an undecided session shows the gate with the composer locked; choosing persists and unlocks', async () => {
    let mode: SessionSummary['permissionMode'] = null
    const patches: unknown[] = []
    const backend = fakeBackend({
      listSessions: async () => [{ ...session, permissionMode: mode }],
      patchSession: async (_id, patch) => {
        patches.push(patch)
        if (patch.permissionMode !== undefined) mode = patch.permissionMode
      },
    })
    renderApp(backend)

    // the launch restore auto-opens the (undecided) session — the gate shows
    await screen.findByRole('group', { name: 'Permissions de la session' })
    const textarea = screen.getByLabelText('Répondre à Claude') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Permissions normales' }))
    await waitFor(() => expect(patches).toEqual([{ permissionMode: 'default' }]))
    await waitFor(() => expect((screen.getByLabelText('Répondre à Claude') as HTMLTextAreaElement).disabled).toBe(false))
    expect(screen.queryByRole('button', { name: 'Permissions normales' })).toBeNull()
  })

  test('the dangerous choice patches bypassPermissions', async () => {
    let mode: SessionSummary['permissionMode'] = null
    const patches: unknown[] = []
    const backend = fakeBackend({
      listSessions: async () => [{ ...session, permissionMode: mode }],
      patchSession: async (_id, patch) => {
        patches.push(patch)
        if (patch.permissionMode !== undefined) mode = patch.permissionMode
      },
    })
    renderApp(backend)

    fireEvent.click(await screen.findByRole('button', { name: /dangereux/i }))
    await waitFor(() => expect(patches).toEqual([{ permissionMode: 'bypassPermissions' }]))
  })

  test('a decided session never shows the gate', async () => {
    renderApp(fakeBackend())
    await waitFor(() => expect((screen.getByLabelText('Répondre à Claude') as HTMLTextAreaElement).disabled).toBe(false))
    expect(screen.queryByRole('button', { name: 'Permissions normales' })).toBeNull()
  })
})

describe('App plan limits panel', () => {
  test('the right panel shows the plan gauges fetched from the backend', async () => {
    renderApp(
      fakeBackend({
        getUsageLimits: async () => [
          { window: 'five_hour', utilization: 34, status: 'allowed', resetsAt: '2099-07-17T16:00:00.000Z', recordedAt: '2026-07-17T12:00:00.000Z' },
        ],
      }),
    )
    await screen.findByText('Session (5 h)')
    expect(screen.getByText('34 %')).toBeTruthy()
  })
})

describe('App update toast', () => {
  test('a newer repo version raises « Une nouvelle version est disponible » with its patch notes, once', async () => {
    const { queryClient } = renderApp(
      fakeBackend({ getVersion: async () => ({ version: '9.9.9', notes: ['Note un', 'Note deux'] }) }),
    )

    await screen.findByText('Une nouvelle version est disponible')
    expect(screen.getByText(/Note un/)).toBeTruthy()
    expect(screen.getByText(/Note deux/)).toBeTruthy()
    expect(screen.getByText(/redémarre Atelier/i)).toBeTruthy()

    // A refetch of the same version must not stack a second toast.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['version'] })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getAllByText('Une nouvelle version est disponible')).toHaveLength(1)
  })

  test('no update toast when the repo version matches the build', async () => {
    renderApp(fakeBackend())
    await screen.findAllByText('Session un') // app settled (sidebar, then topbar once restored)
    expect(screen.queryByText('Une nouvelle version est disponible')).toBeNull()
  })

  test('a failed version fetch stays silent — no toast, no crash', async () => {
    renderApp(fakeBackend({ getVersion: async () => Promise.reject(new Error('GET /api/version → 500')) }))
    await screen.findAllByText('Session un')
    expect(screen.queryByText('Une nouvelle version est disponible')).toBeNull()
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

describe('App dashboard widgets', () => {
  test('PUT /widgets failure: layout rolls back and a notice appears', async () => {
    const backend = fakeBackend({
      putWidgets: async () => {
        throw new Error('boom')
      },
    })
    renderApp(backend)
    fireEvent.keyDown((await screen.findAllByRole('button', { name: /Options du widget/ }))[0]!, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Retirer' }))
    await screen.findByText(/Impossible d’enregistrer le layout/)
    expect(screen.getAllByRole('group')).toHaveLength(2)
  })
})

describe('App session deletion', () => {
  test('the × on a real session opens the dialog; confirming deletes through the backend', async () => {
    const deleted: string[] = []
    renderApp(
      fakeBackend({
        deleteSession: async (id) => {
          deleted.push(id)
        },
      }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Supprimer la conversation' }))
    // the dialog is a gate — nothing deleted yet
    expect(deleted).toEqual([])
    expect(screen.getByRole('dialog').textContent).toContain('« Session un » sera définitivement supprimée.')

    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))

    await waitFor(() => expect(deleted).toEqual(['s1']))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('deleting the SELECTED session deselects it and refreshes the list', async () => {
    let sessions: SessionSummary[] = [session]
    const closes: number[] = []
    renderApp(
      fakeBackend({
        listSessions: async () => sessions,
        deleteSession: async (id) => {
          sessions = sessions.filter((s) => s.id !== id)
        },
        // Track socket teardown: deleting the selected session must close its stream.
        createSocket: () => ({ ...idleSocket, close: () => closes.push(1) }),
      }),
    )

    // the launch restore selects the session — the Topbar shows its rename affordance
    await screen.findByRole('button', { name: /renommer la session/i })

    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))

    // list refetched without the session, and the deleted session was deselected.
    // queryAllByText: while selected, 'Session un' appears TWICE (sidebar + Topbar)
    // — an all-gone assertion fails cleanly instead of a multiple-match timeout.
    await waitFor(() => expect(screen.queryAllByText('Session un')).toHaveLength(0))
    expect(screen.queryByRole('button', { name: /renommer la session/i })).toBeNull()
    // Pin the deselection itself (`setSelected(null)`) — the two assertions
    // above also hold from the list refetch alone. A dangling selection would
    // leave the composer enabled against a deleted session.
    expect((screen.getByLabelText('Répondre à Claude') as HTMLTextAreaElement).disabled).toBe(true)
    // Pin `controller.close()` — the deleted session's socket must be torn down.
    expect(closes.length).toBeGreaterThan(0)
  })

  test(
    'deleting a NON-selected session leaves the selection alone',
    async () => {
      const other: SessionSummary = { ...session, id: 's2', name: 'Session deux' }
      let sessions: SessionSummary[] = [session, other]
      renderApp(
        fakeBackend({
          listSessions: async () => sessions,
          deleteSession: async (id) => {
            sessions = sessions.filter((s) => s.id !== id)
          },
        }),
      )

      // the restore selects 'Session un' (first of the tie on updatedAt), then
      // delete 'Session deux' from ITS row (two × buttons share the label —
      // scope with within(row))
      await screen.findByRole('button', { name: /renommer la session « session un »/i })

      const otherRow = screen.getByText('Session deux').closest('.sess') as HTMLElement
      fireEvent.click(within(otherRow).getByRole('button', { name: 'Supprimer la conversation' }))
      fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))

      // 'Session deux' leaves the list; 'Session un' stays selected — the guard
      // branch (`if (selected?.sessionId === session.id)`) must not over-deselect
      await waitFor(() => expect(screen.queryByText('Session deux')).toBeNull())
      expect(screen.getByRole('button', { name: /renommer la session « session un »/i })).toBeTruthy()
    },
    // Pre-existing (not Task 9's doing): with the selected session's ChatView left
    // mounted through this delete, some effect settles very slowly under happy-dom
    // — real but env-specific, and the extra widgets query/mount per App render
    // tips it past the 5s default. Generous headroom, not a correctness signal.
    15000,
  )

  test('cancelling the dialog deletes nothing', async () => {
    const deleted: string[] = []
    renderApp(
      fakeBackend({
        deleteSession: async (id) => {
          deleted.push(id)
        },
      }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Supprimer la conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deleted).toEqual([])
  })

  test('a failed deletion surfaces a dismissible notice', async () => {
    renderApp(fakeBackend({ deleteSession: async () => Promise.reject(new Error('DELETE /api/sessions/s1 → 500')) }))

    fireEvent.click(await screen.findByRole('button', { name: 'Supprimer la conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))

    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Impossible de supprimer la session')
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(screen.queryByText(/Impossible de supprimer la session/)).toBeNull()
    // no optimistic removal: the SIDEBAR row must survive a failed delete
    // (getAll: the auto-selected session's name also shows in the Topbar)
    expect(screen.getAllByText('Session un').some((el) => el.closest('.sess') !== null)).toBe(true)
  })

  test('a draft × deletes instantly — no confirmation dialog', async () => {
    const draft: SessionSummary = { ...session, id: 'd1', name: null, isDraft: true, messageCount: 0, permissionMode: null }
    const deleted: string[] = []
    renderApp(
      fakeBackend({
        listSessions: async () => [session, draft],
        deleteSession: async (id) => {
          deleted.push(id)
        },
      }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Supprimer le brouillon' }))

    await waitFor(() => expect(deleted).toEqual(['d1']))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('App launch restore (spec 2026-07-24)', () => {
  // Two real sessions: s2 is the most recent — the fallback target.
  const sessionTwo: SessionSummary = { ...session, id: 's2', name: 'Session deux', updatedAt: '2026-07-16T10:00:00.000Z' }
  const twoSessions = async () => [session, sessionTwo]
  const storageKey = 'atelier:lastSession'
  const stored = () => {
    const raw = localStorage.getItem(storageKey)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  }

  test('the remembered session reopens at launch — composer typeable without a click', async () => {
    localStorage.setItem(storageKey, JSON.stringify({ sessionId: 's1', projectId: 'p1' }))
    renderApp(fakeBackend({ listSessions: twoSessions }))

    // s1 is remembered → it wins over the more recent s2
    await screen.findByRole('button', { name: /renommer la session « session un »/i })
    expect((screen.getByLabelText('Répondre à Claude') as HTMLTextAreaElement).disabled).toBe(false)
  })

  test('a vanished remembered session falls back to the most recent one', async () => {
    localStorage.setItem(storageKey, JSON.stringify({ sessionId: 's-dead', projectId: 'p1' }))
    renderApp(fakeBackend({ listSessions: twoSessions }))
    await screen.findByRole('button', { name: /renommer la session « session deux »/i })
  })

  test('a vanished remembered project falls back to the first project', async () => {
    localStorage.setItem(storageKey, JSON.stringify({ sessionId: 's1', projectId: 'p-dead' }))
    renderApp(fakeBackend({ listSessions: twoSessions }))
    await screen.findByRole('button', { name: /renommer la session « session un »/i })
  })

  test('the remembered PROJECT reopens too — its session list is where the id lives', async () => {
    const blog: ProjectSummary = { id: 'p2', path: '/Users/demo/workspace/blog', color: 'magenta', sessionCount: 1 }
    const blogSession: SessionSummary = { ...session, id: 's9', projectId: 'p2', name: 'Article' }
    localStorage.setItem(storageKey, JSON.stringify({ sessionId: 's9', projectId: 'p2' }))
    renderApp(
      fakeBackend({
        listProjects: async () => [project, blog],
        listSessions: async (projectId) => (projectId === 'p2' ? [blogSession] : [session]),
      }),
    )

    await screen.findByRole('button', { name: /renommer la session « article »/i })
    expect(screen.getByText('blog').className).toContain('open')
  })

  test('nothing stored → the most recent session still opens (typeable cold start)', async () => {
    renderApp(fakeBackend({ listSessions: twoSessions }))
    await screen.findByRole('button', { name: /renommer la session « session deux »/i })
  })

  test('corrupt storage behaves as nothing stored — fallback, no crash', async () => {
    localStorage.setItem(storageKey, '{oops')
    renderApp(fakeBackend({ listSessions: twoSessions }))
    await screen.findByRole('button', { name: /renommer la session « session deux »/i })
  })

  test('no session at all → empty state unchanged, composer disabled', async () => {
    renderApp(fakeBackend({ listSessions: async () => [] }))
    await screen.findByText('atelier') // sidebar settled
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect((screen.getByLabelText('Répondre à Claude') as HTMLTextAreaElement).disabled).toBe(true)
  })

  test('selecting a session records it for the next launch', async () => {
    renderApp(fakeBackend({ listSessions: twoSessions }))
    // the restore auto-opens s2 (most recent) — then the user picks s1 manually
    await screen.findByRole('button', { name: /renommer la session « session deux »/i })
    const row = screen.getAllByText('Session un').find((el) => el.closest('.sess') !== null)!
    fireEvent.click(row)
    await waitFor(() => expect(stored()).toEqual({ sessionId: 's1', projectId: 'p1' }))
  })

  test('a manual project click before the restore fires cancels it — no unchosen session opens', async () => {
    const blog: ProjectSummary = { id: 'p2', path: '/Users/demo/workspace/blog', color: 'magenta', sessionCount: 1 }
    // Sessions stay pending until released — the click happens inside the window.
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    renderApp(
      fakeBackend({
        listProjects: async () => [project, blog],
        listSessions: async (projectId) => {
          await gate
          return [{ ...session, projectId }]
        },
      }),
    )

    fireEvent.click(await screen.findByText('blog'))
    release!()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => expect(screen.getByText('blog').className).toContain('open'))
    // the user navigated deliberately — nothing auto-opens behind their back
    expect(screen.queryByRole('button', { name: /renommer la session/i })).toBeNull()
    expect((screen.getByLabelText('Répondre à Claude') as HTMLTextAreaElement).disabled).toBe(true)
  })

  test('the draft→session remap rewrites the stored id for the next launch', async () => {
    let emit: ((event: ServerEvent) => void) | null = null
    renderApp(
      fakeBackend({
        createSocket: () => ({
          ...idleSocket,
          on: (handler: (event: ServerEvent) => void) => {
            emit = handler
            return () => {}
          },
        }),
      }),
    )

    await screen.findByRole('button', { name: /renommer la session/i }) // restore settled on s1
    fireEvent.click(screen.getByRole('button', { name: '+ Session' }))
    await waitFor(() => expect(stored()).toEqual({ sessionId: 'd1', projectId: 'p1' }))

    // the server materializes the draft mid-first-turn → status carries the mapping
    await waitFor(() => expect(emit).not.toBeNull())
    act(() => emit!({ type: 'status', sessionId: 'sdk-1', state: 'idle', mapping: { draftId: 'd1', sessionId: 'sdk-1' } }))
    await waitFor(() => expect(stored()).toEqual({ sessionId: 'sdk-1', projectId: 'p1' }))
  })

  test('deleting the selected session clears the stored entry', async () => {
    let sessions: SessionSummary[] = [session]
    renderApp(
      fakeBackend({
        listSessions: async () => sessions,
        deleteSession: async (id) => {
          sessions = sessions.filter((s) => s.id !== id)
        },
      }),
    )

    await screen.findByRole('button', { name: /renommer la session « session un »/i }) // restored → stored
    expect(stored()).toEqual({ sessionId: 's1', projectId: 'p1' })
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))
    await waitFor(() => expect(stored()).toBeNull())
  })
})
