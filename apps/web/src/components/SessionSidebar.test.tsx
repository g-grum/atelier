import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Project, SessionSummary } from '@atelier/shared'
import { SessionSidebar, type SessionSidebarProps } from './SessionSidebar'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const project: Project = { id: 'p1', path: '/Users/demo/workspace/atelier', color: 'cyan' }

const realSession: SessionSummary = {
  id: 's1',
  projectId: 'p1',
  name: 'Refresh token expiré',
  updatedAt: '2026-07-15T09:41:00.000Z',
  messageCount: 5,
  isDraft: false,
  model: 'claude-fable-5',
}

const draftSession: SessionSummary = {
  id: 'd1',
  projectId: 'p1',
  name: null,
  updatedAt: '2026-07-15T09:45:00.000Z',
  messageCount: 0,
  isDraft: true,
  model: 'claude-fable-5',
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
    onSelectProject: () => {},
    onSelect: (session) => calls.selected.push(session),
    onCreateDraft: () => {},
    onDeleteDraft: (session) => calls.deleted.push(session),
    onRegisterProject: (path) => calls.registered.push(path),
    onRetryProjects: () => {},
    ...overrides,
  }
  const view = render(<SessionSidebar {...props} />)
  return { calls, view }
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

  test('clicking a session row calls onSelect with that session', () => {
    const { calls } = renderSidebar()
    fireEvent.click(within(rowOf('Refresh token expiré')).getByRole('button', { name: /refresh token expiré/i }))
    expect(calls.selected).toEqual([realSession])
  })

  test('a draft row shows the delete button, a real session does not', () => {
    const { calls } = renderSidebar()
    const draftRow = rowOf('Nouvelle session')
    const deleteButton = within(draftRow).getByRole('button', { name: /supprimer le brouillon/i })
    expect(within(rowOf('Refresh token expiré')).queryByRole('button', { name: /supprimer/i })).toBeNull()

    // Deleting must not also select the row.
    fireEvent.click(deleteButton)
    expect(calls.deleted).toEqual([draftSession])
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

describe('SessionSidebar empty state', () => {
  test('with no registered project, shows the folder-path register form', () => {
    const { calls } = renderSidebar({ projects: [], sessions: [], openProjectId: null, activeSessionId: null })

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
