import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ProjectSummary, SessionSummary } from '@atelier/shared'
import { SessionSidebar, type SessionSidebarProps } from './SessionSidebar'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

// sessionCount deliberately differs from sessions.length (2): the open row
// must prefer the fresher live list, closed rows show the server count.
const project: ProjectSummary = { id: 'p1', path: '/Users/demo/workspace/atelier', color: 'cyan', sessionCount: 5 }
const otherProject: ProjectSummary = { id: 'p2', path: '/Users/demo/workspace/demoapp-backend', color: 'magenta', sessionCount: 7 }

const realSession: SessionSummary = {
  id: 's1',
  projectId: 'p1',
  name: 'Refresh token expiré',
  updatedAt: '2026-07-15T09:41:00.000Z',
  messageCount: 5,
  isDraft: false,
  model: 'claude-fable-5',
  permissionMode: 'default',
}

const draftSession: SessionSummary = {
  id: 'd1',
  projectId: 'p1',
  name: null,
  updatedAt: '2026-07-15T09:45:00.000Z',
  messageCount: 0,
  isDraft: true,
  model: 'claude-fable-5',
  permissionMode: null,
}

function renderSidebar(overrides: Partial<SessionSidebarProps> = {}) {
  const calls = {
    selected: [] as SessionSummary[],
    deleted: [] as SessionSummary[],
    registered: [] as string[],
  }
  const props: SessionSidebarProps = {
    projects: [project],
    projectsStatus: 'success',
    sessions: [realSession, draftSession],
    openProjectId: 'p1',
    activeSessionId: 's1',
    streamingSessionId: null,
    statuses: new Map(),
    waiting: new Set(),
    onSelectProject: () => {},
    onSelect: (session) => calls.selected.push(session),
    onCreateDraft: () => {},
    onDelete: (session) => calls.deleted.push(session),
    onRegisterProject: (path) => calls.registered.push(path),
    onRetryProjects: () => {},
    ...overrides,
  }
  const view = render(<SessionSidebar {...props} />)
  return { calls, view, props }
}

/** The session row element wrapping the given visible name. */
function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest('.sess')
  if (!(row instanceof HTMLElement)) throw new Error(`no session row for "${name}"`)
  return row
}

function dotState(name: string): string | null {
  return rowOf(name).querySelector('.dot')?.getAttribute('data-state') ?? null
}

describe('SessionSidebar sessions', () => {
  test('renders session names with their state dots (done / idle / run)', () => {
    renderSidebar()
    // Real session with history, not streaming → outlined "done" dot.
    expect(dotState('Refresh token expiré')).toBe('done')
    // Draft (no messages yet) → faint filled "idle" dot; null name gets the French fallback.
    expect(dotState('Nouvelle session')).toBe('idle')

    cleanup()
    renderSidebar({ streamingSessionId: 's1' })
    // The streaming session gets the pulsing mint "run" dot.
    expect(dotState('Refresh token expiré')).toBe('run')
  })

  test('vert (run) quand le hub signale streaming pour la session', () => {
    renderSidebar({ statuses: new Map([['s1', 'streaming']]) })
    expect(dotState('Refresh token expiré')).toBe('run')
  })

  test('bleu (waiting) quand la session est en attente hors focus', () => {
    // NB : `dotState` ignore volontairement le focus — le vidage au focus vit dans
    // le store (setActive), pas ici. Le défaut activeSessionId='s1' n'affecte donc rien.
    renderSidebar({ waiting: new Set(['s1']) })
    expect(dotState('Refresh token expiré')).toBe('waiting')
  })

  test('le vert prime le bleu (priorité run > waiting)', () => {
    renderSidebar({ statuses: new Map([['s1', 'streaming']]), waiting: new Set(['s1']) })
    expect(dotState('Refresh token expiré')).toBe('run')
  })

  test('clicking a session row calls onSelect with that session', () => {
    const { calls } = renderSidebar()
    fireEvent.click(within(rowOf('Refresh token expiré')).getByRole('button', { name: /refresh token expiré/i }))
    expect(calls.selected).toEqual([realSession])
  })

  test('every row shows a delete button — draft vs conversation label', () => {
    const { calls } = renderSidebar()
    const draftDelete = within(rowOf('Nouvelle session')).getByRole('button', { name: 'Supprimer le brouillon' })
    const realDelete = within(rowOf('Refresh token expiré')).getByRole('button', { name: 'Supprimer la conversation' })

    // Deleting must not also select the row.
    fireEvent.click(draftDelete)
    expect(calls.deleted).toEqual([draftSession])
    fireEvent.click(realDelete)
    expect(calls.deleted).toEqual([draftSession, realSession])
    expect(calls.selected).toEqual([])
  })

  test('select and draft-delete are sibling native buttons — no interactive ancestor', () => {
    renderSidebar()
    const draftRow = rowOf('Nouvelle session')
    const deleteButton = within(draftRow).getByRole('button', { name: /supprimer le brouillon/i })
    // Conforming HTML: ARIA `button` has presentational children, so nesting
    // the delete control inside a role="button" row would flatten it away from
    // assistive tech. It must be a real <button> with no interactive ancestor.
    expect(deleteButton.tagName).toBe('BUTTON')
    expect(deleteButton.parentElement?.closest('button, [role="button"], [tabindex]')).toBeNull()
    // The select affordance is its own native sibling button, so both are
    // independent tab stops (the delete becomes keyboard-reachable at all).
    const selectButton = within(draftRow).getByRole('button', { name: /nouvelle session/i })
    expect(selectButton.tagName).toBe('BUTTON')
    expect(selectButton === deleteButton).toBe(false)
    expect(selectButton.parentElement?.closest('button, [role="button"], [tabindex]')).toBeNull()
  })
})

describe('SessionSidebar projects', () => {
  /** The project row element (`.project-name`) wrapping the given visible basename. */
  function projectRowOf(name: string): HTMLElement {
    const row = screen.getByText(name).closest('.project-name')
    if (!(row instanceof HTMLElement)) throw new Error(`no project row for "${name}"`)
    return row
  }

  test('every project row shows its session count, not only the open one', () => {
    renderSidebar({ projects: [project, otherProject] })
    // Closed row: the server-computed sessionCount from ProjectSummary.
    expect(projectRowOf('demoapp-backend').querySelector('.count')?.textContent).toBe('7')
    // Open row: the live sessions list (2 entries) is fresher than the
    // projects snapshot (sessionCount: 5) — it wins.
    expect(projectRowOf('atelier').querySelector('.count')?.textContent).toBe('2')
  })

  test('« + Projet » toggles the register form and submitting registers the typed path', () => {
    const { calls } = renderSidebar({ projects: [project, otherProject] })

    // Discreet permanent affordance: the form stays hidden until asked for.
    const toggle = screen.getByRole('button', { name: '+ Projet' })
    expect(screen.queryByPlaceholderText('/chemin/absolu/du/projet')).toBeNull()

    // Same RegisterProjectForm as the first-launch empty state.
    fireEvent.click(toggle)
    const input = screen.getByPlaceholderText('/chemin/absolu/du/projet')
    fireEvent.change(input, { target: { value: '/Users/demo/workspace/demoapp-frontend' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(calls.registered).toEqual(['/Users/demo/workspace/demoapp-frontend'])

    // Toggling again hides the form.
    fireEvent.click(toggle)
    expect(screen.queryByPlaceholderText('/chemin/absolu/du/projet')).toBeNull()
  })

  test('the register form auto-closes when the registration lands (projects list grows)', () => {
    const { view, props } = renderSidebar({ projects: [project] })
    fireEvent.click(screen.getByRole('button', { name: '+ Projet' }))
    expect(screen.getByPlaceholderText('/chemin/absolu/du/projet')).toBeTruthy()

    // The POST landed: the refetched projects list grew by one.
    view.rerender(<SessionSidebar {...props} projects={[project, otherProject]} />)
    expect(screen.queryByPlaceholderText('/chemin/absolu/du/projet')).toBeNull()
  })

  test('a failed registration is surfaced inside the footer form', () => {
    renderSidebar({ projects: [project], registerError: 'POST /api/projects → 500' })
    fireEvent.click(screen.getByRole('button', { name: '+ Projet' }))
    expect(screen.getByRole('alert').textContent).toContain('POST /api/projects → 500')
  })
})

describe('SessionSidebar empty state', () => {
  test('with no registered project, shows the folder-path register form directly (no toggle)', () => {
    const { calls } = renderSidebar({ projects: [], sessions: [], openProjectId: null, activeSessionId: null })

    // First launch: the form IS the sidebar content — no « + Projet » detour.
    expect(screen.queryByRole('button', { name: '+ Projet' })).toBeNull()
    const input = screen.getByPlaceholderText('/chemin/absolu/du/projet')
    const button = screen.getByRole('button', { name: 'Enregistrer' })
    fireEvent.change(input, { target: { value: '/Users/germain/workspace/atelier' } })
    fireEvent.click(button)
    expect(calls.registered).toEqual(['/Users/germain/workspace/atelier'])
  })

  test('the register form is absent once a project exists', () => {
    renderSidebar()
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).toBeNull()
    expect(screen.getByText('atelier')).toBeTruthy() // project row: basename of the path
  })

  test('the register form never shows while the projects query is still loading', () => {
    renderSidebar({ projects: [], sessions: [], openProjectId: null, activeSessionId: null, projectsStatus: 'pending' })
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull() // loading is not an error either
  })

  test('a failed projects fetch shows an error with a retry, not the register form', () => {
    let retries = 0
    renderSidebar({
      projects: [],
      sessions: [],
      openProjectId: null,
      activeSessionId: null,
      projectsStatus: 'error',
      projectsError: 'GET /api/projects → 401',
      onRetryProjects: () => {
        retries += 1
      },
    })
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('GET /api/projects → 401')
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(retries).toBe(1)
  })

  test('a failed registration is surfaced inside the form', () => {
    renderSidebar({
      projects: [],
      sessions: [],
      openProjectId: null,
      activeSessionId: null,
      registerError: 'POST /api/projects → 500',
    })
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('POST /api/projects → 500')
  })
})
