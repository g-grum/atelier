import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AlwaysRule, Preferences } from '@atelier/shared'
import { SettingsPanel, type SettingsApi } from './SettingsPanel'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const preferences: Preferences = { ide: 'webstorm', defaultModel: 'claude-fable-5' }

const rule: AlwaysRule = { id: 'r1', projectId: 'p1', toolName: 'Bash', matcher: 'git push' }

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
})
