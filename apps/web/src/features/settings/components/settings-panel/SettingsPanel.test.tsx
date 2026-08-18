import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AlwaysRule, Preferences, ProjectSummary } from '@atelier/shared'
import { SettingsPanel, type SettingsApi } from '@/features/settings/components/settings-panel/SettingsPanel'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)
afterEach(() => document.documentElement.removeAttribute('data-theme'))

const preferences: Preferences = { ide: 'webstorm', defaultModel: 'claude-fable-5', windowBudgetTokens: 2_000_000, weeklyBudgetTokens: 12_000_000, githubUser: 'alice-dev' }

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
  // Régression : le dialog est centré en position fixed sans plafond de hauteur.
  // Dès que les listes non bornées (règles « toujours autoriser », projets) font
  // dépasser le contenu de la fenêtre, le centrage pousse le haut ET le bas hors
  // du viewport — et rien n'est défilable, donc les deux extrémités deviennent
  // définitivement inatteignables. jsdom ne fait pas de layout : on verrouille
  // la présence du plafond + du conteneur de défilement, pas la géométrie.
  test('le contenu du dialog est borné en hauteur et absorbe le débordement par un scroller', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByLabelText('Preferred IDE')

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('max-h-')
    // Sans piste de grille contrainte, la rangée reste en `auto` (dimensionnée par le
    // contenu) et déborde du plafond : mesuré en vrai navigateur, le scroller affichait
    // alors clientHeight == scrollHeight == 2952 et ne défilait pas. Vérifié corrigé :
    // client 556 / scroll 2952. Ne pas retirer ce plafond de rangée.
    expect(dialog.className).toContain('grid-rows-[minmax(0,1fr)]')

    const scroller = dialog.querySelector('[data-dialog-scroll]')
    expect(scroller).not.toBeNull()
    expect(scroller?.className).toContain('overflow-y-auto')
    // le scroller doit contenir le corps réglages, pas juste exister
    expect(scroller?.contains(screen.getByLabelText('Preferred IDE'))).toBe(true)
  })

  test('the gear opens the dialog; selects show the preferences and PATCH on change', async () => {
    const calls = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    const ideSelect = (await screen.findByLabelText('Preferred IDE')) as HTMLSelectElement
    expect(ideSelect.value).toBe('webstorm')
    fireEvent.change(ideSelect, { target: { value: 'cursor' } })
    await waitFor(() => expect(calls.patches).toEqual([{ ide: 'cursor' }]))

    const modelSelect = screen.getByLabelText('Default model') as HTMLSelectElement
    expect(modelSelect.value).toBe('claude-fable-5')
    fireEvent.change(modelSelect, { target: { value: 'claude-opus-4-8' } })
    await waitFor(() => expect(calls.patches).toEqual([{ ide: 'cursor' }, { defaultModel: 'claude-opus-4-8' }]))
  })

  test('the « Thème » select reflects prefs.theme, defaulting to « dark » when absent', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const themeSelect = (await screen.findByLabelText('Theme')) as HTMLSelectElement
    expect(themeSelect.value).toBe('dark') // preferences has no `theme` → prefs.theme ?? 'dark'

    cleanup()
    renderPanel({ getPreferences: async () => ({ ...preferences, theme: 'light' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const lightSelect = (await screen.findByLabelText('Theme')) as HTMLSelectElement
    expect(lightSelect.value).toBe('light')
  })

  test('changing the « Thème » select PATCHes the preference AND re-themes the DOM', async () => {
    const calls = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const themeSelect = (await screen.findByLabelText('Theme')) as HTMLSelectElement

    fireEvent.change(themeSelect, { target: { value: 'light' } })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    await waitFor(() => expect(calls.patches).toEqual([{ theme: 'light' }]))
  })

  test('the permissions select shows the current default and PATCHes changes — null clears', async () => {
    const calls = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    const select = (await screen.findByLabelText('New-session permissions')) as HTMLSelectElement
    // preferences fixture sans defaultPermissionMode → « demander à chaque session »
    expect(select.value).toBe('')

    fireEvent.change(select, { target: { value: 'bypassPermissions' } })
    await waitFor(() => expect(calls.patches).toEqual([{ defaultPermissionMode: 'bypassPermissions' }]))

    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() =>
      expect(calls.patches).toEqual([{ defaultPermissionMode: 'bypassPermissions' }, { defaultPermissionMode: null }]),
    )
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
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    const row = await screen.findByText('git push')
    expect(row.closest('li')?.textContent).toContain('Bash')

    fireEvent.click(screen.getByRole('button', { name: 'Delete the rule “Bash: git push”' }))
    await screen.findByText('No “always allow” rule recorded.')
    expect(deleted).toEqual(['r1'])
  })

  test('a null matcher renders “entire tool”', async () => {
    renderPanel({ listRules: async () => [{ ...rule, matcher: null }] })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByText('entire tool')
    expect(screen.getByRole('button', { name: 'Delete the rule “Bash: entire tool”' })).toBeTruthy()
  })

  test('the « Projets » section lists projects (basename, full path in title) with the ~/.claude hint', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    const row = await screen.findByTitle('/tmp/demo/atelier')
    expect(row.textContent).toBe('atelier')
    expect(screen.getByText('Removing a project keeps its conversations in ~/.claude')).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Remove the project “atelier”' }))
    expect(removed).toEqual([]) // armed, nothing deleted yet
    // The armed button keeps naming the project (aria-label); its visible text asks confirmation.
    const confirm = screen.getByRole('button', { name: 'Confirm removing “atelier”' })
    expect(confirm.textContent).toBe('Confirm removal?')
    fireEvent.click(confirm)
    await waitFor(() => expect(removed).toEqual(['p1']))
    // ['projects'] invalidated → the list refetches through the seam and empties.
    await waitFor(() => expect(screen.queryByTitle('/tmp/demo/atelier')).toBeNull())
    await screen.findByText('No registered projects.')
  })

  test('arming a second project disarms the first (a single confirmation at a time)', async () => {
    const other: ProjectSummary = { id: 'p2', path: '/tmp/demo/blog', color: '#4ade80', sessionCount: 0 }
    renderPanel({ listProjects: async () => [project, other] })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Remove the project “atelier”' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the project “blog”' }))
    expect(screen.getByRole('button', { name: 'Confirm removing “blog”' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm removing “atelier”' })).toBeNull()
    // atelier's row reverted to its unarmed button
    expect(screen.getByRole('button', { name: 'Remove the project “atelier”' })).toBeTruthy()
  })
})
