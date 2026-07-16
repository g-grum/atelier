import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AlwaysRule, Preferences, ProjectSummary } from '@atelier/shared'
import { SettingsPanel, type SettingsApi } from './SettingsPanel'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const preferences: Preferences = { ide: 'webstorm', defaultModel: 'claude-fable-5', windowBudgetTokens: 2_000_000, weeklyBudgetTokens: 12_000_000 }

const rule: AlwaysRule = { id: 'r1', projectId: 'p1', toolName: 'Bash', matcher: 'git push' }

const project: ProjectSummary = { id: 'p1', path: '/tmp/demo/atelier', color: '#7c86ff', sessionCount: 2 }

function renderPanel(overrides: Partial<SettingsApi> = {}) {
  const calls = { patches: [] as Partial<Preferences>[], deleted: [] as string[] }
  const api: SettingsApi = {
    getPreferences: async () => preferences,
    patchPreferences: async (patch) => {
      calls.patches.push(patch)
      return { ...preferences, ...patch }
    },
    listRules: async () => [rule],
    deleteRule: async (id) => {
      calls.deleted.push(id)
    },
    listProjects: async () => [project],
    deleteProject: async () => {},
    ...overrides,
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsPanel api={api} />
    </QueryClientProvider>,
  )
  return calls
}

describe('SettingsPanel', () => {
  test('the gear opens the dialog; selects show the preferences and PATCH on change', async () => {
    const calls = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Réglages' }))

    const ideSelect = (await screen.findByLabelText('IDE préféré')) as HTMLSelectElement
    expect(ideSelect.value).toBe('webstorm')
    fireEvent.change(ideSelect, { target: { value: 'cursor' } })
    await waitFor(() => expect(calls.patches).toEqual([{ ide: 'cursor' }]))

    const modelSelect = screen.getByLabelText('Modèle par défaut') as HTMLSelectElement
    expect(modelSelect.value).toBe('claude-fable-5')
    fireEvent.change(modelSelect, { target: { value: 'claude-opus-4-8' } })
    await waitFor(() => expect(calls.patches).toEqual([{ ide: 'cursor' }, { defaultModel: 'claude-opus-4-8' }]))
  })

  test('a rule row shows « toolName : matcher »; deleting it refreshes to the empty state', async () => {
    let rules: AlwaysRule[] = [rule]
    const deleted: string[] = []
    renderPanel({
      listRules: async () => rules,
      deleteRule: async (id) => {
        deleted.push(id)
        rules = rules.filter((entry) => entry.id !== id)
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Réglages' }))

    const row = await screen.findByText('git push')
    expect(row.closest('li')?.textContent).toContain('Bash')

    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la règle « Bash : git push »' }))
    await screen.findByText('Aucune règle « toujours autoriser » enregistrée.')
    expect(deleted).toEqual(['r1'])
  })

  test('a null matcher renders « outil entier »', async () => {
    renderPanel({ listRules: async () => [{ ...rule, matcher: null }] })
    fireEvent.click(screen.getByRole('button', { name: 'Réglages' }))
    await screen.findByText('outil entier')
    expect(screen.getByRole('button', { name: 'Supprimer la règle « Bash : outil entier »' })).toBeTruthy()
  })

  test('the « Projets » section lists projects (basename, full path in title) with the ~/.claude hint', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Réglages' }))

    const row = await screen.findByTitle('/tmp/demo/atelier')
    expect(row.textContent).toBe('atelier')
    expect(screen.getByText('Retirer le projet (les conversations restent dans ~/.claude)')).toBeTruthy()
  })

  test('unregistering is two-step: the first click only arms, the second deletes and refreshes the list', async () => {
    let projects: ProjectSummary[] = [project]
    const removed: string[] = []
    renderPanel({
      listProjects: async () => projects,
      deleteProject: async (id) => {
        removed.push(id)
        projects = projects.filter((entry) => entry.id !== id)
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Réglages' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Retirer le projet « atelier »' }))
    expect(removed).toEqual([]) // armed, nothing deleted yet
    // The armed button keeps naming the project (aria-label); its visible text asks confirmation.
    const confirm = screen.getByRole('button', { name: 'Confirmer le retrait de « atelier »' })
    expect(confirm.textContent).toBe('Confirmer le retrait ?')
    fireEvent.click(confirm)
    await waitFor(() => expect(removed).toEqual(['p1']))
    // ['projects'] invalidated → the list refetches through the seam and empties.
    await waitFor(() => expect(screen.queryByTitle('/tmp/demo/atelier')).toBeNull())
    await screen.findByText('Aucun projet enregistré.')
  })

  test('arming a second project disarms the first (a single confirmation at a time)', async () => {
    const other: ProjectSummary = { id: 'p2', path: '/tmp/demo/blog', color: '#4ade80', sessionCount: 0 }
    renderPanel({ listProjects: async () => [project, other] })
    fireEvent.click(screen.getByRole('button', { name: 'Réglages' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Retirer le projet « atelier »' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retirer le projet « blog »' }))
    expect(screen.getByRole('button', { name: 'Confirmer le retrait de « blog »' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirmer le retrait de « atelier »' })).toBeNull()
    // atelier's row reverted to its unarmed button
    expect(screen.getByRole('button', { name: 'Retirer le projet « atelier »' })).toBeTruthy()
  })
})
