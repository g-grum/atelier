import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModifiedFilesPanel, type ModifiedFilesApi, type ToastFailure } from './ModifiedFilesPanel'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

type ModifiedFiles = Map<string, { added: number; removed: number; lastLine?: number }>

const files: ModifiedFiles = new Map([
  ['apps/web/src/TodoColumn.tsx', { added: 43, removed: 12, lastLine: 128 }],
  ['i18n/en/submissions.json', { added: 1, removed: 0 }],
])

function renderPanel(entries: ModifiedFiles, result: Awaited<ReturnType<ModifiedFilesApi['openInIde']>> = { ok: true }) {
  const calls: { file: string; line?: number }[] = []
  const toasts: { message: string; action: { label: string; onClick: () => void } }[] = []
  const api: ModifiedFilesApi = {
    openInIde: async (args) => {
      calls.push(args)
      return result
    },
  }
  const toastFailure: ToastFailure = (message, options) => {
    toasts.push({ message, action: options.action })
  }
  render(<ModifiedFilesPanel files={entries} api={api} toastFailure={toastFailure} />)
  return { calls, toasts }
}

describe('ModifiedFilesPanel', () => {
  test('renders one row per file: basename, full path in title, diffstat +N/−N', () => {
    renderPanel(files)
    const row = screen.getByRole('button', { name: 'Ouvrir apps/web/src/TodoColumn.tsx dans l’IDE' })
    expect(row.title).toBe('apps/web/src/TodoColumn.tsx')
    expect(row.textContent).toContain('TodoColumn.tsx')
    expect(row.textContent).toContain('+43')
    expect(row.textContent).toContain('−12')

    // Zero-removed diffstat renders only the added side.
    const jsonRow = screen.getByRole('button', { name: 'Ouvrir i18n/en/submissions.json dans l’IDE' })
    expect(jsonRow.textContent).toContain('+1')
    expect(jsonRow.textContent).not.toContain('−')
  })

  test('empty session: shows the empty state, no rows, no « tout ouvrir »', () => {
    renderPanel(new Map())
    screen.getByText('Aucun fichier modifié pendant cette session.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('row click POSTs { file, line: lastLine }', async () => {
    const { calls, toasts } = renderPanel(files)
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir apps/web/src/TodoColumn.tsx dans l’IDE' }))
    await waitFor(() => expect(calls).toEqual([{ file: 'apps/web/src/TodoColumn.tsx', line: 128 }]))
    expect(toasts).toEqual([])
  })

  test('« tout ouvrir » POSTs every listed file (with its lastLine)', async () => {
    const { calls } = renderPanel(files)
    fireEvent.click(screen.getByRole('button', { name: 'tout ouvrir' }))
    await waitFor(() =>
      expect(calls).toEqual([
        { file: 'apps/web/src/TodoColumn.tsx', line: 128 },
        { file: 'i18n/en/submissions.json', line: undefined },
      ]),
    )
  })

  test('{ ok: false, reason } → toast with the reason and a copy-path action', async () => {
    const { toasts } = renderPanel(files, { ok: false, reason: 'aucun IDE détecté' })
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir apps/web/src/TodoColumn.tsx dans l’IDE' }))

    await waitFor(() => expect(toasts.length).toBe(1))
    expect(toasts[0]!.message).toContain('aucun IDE détecté')
    expect(toasts[0]!.action.label).toBe('Copier le chemin')

    // The action copies the FULL path to the clipboard.
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    })
    toasts[0]!.action.onClick()
    await waitFor(() => expect(written).toEqual(['apps/web/src/TodoColumn.tsx']))
  })

  test('a rejected POST is caught and toasts too (no unhandled rejection)', async () => {
    const toasts: string[] = []
    const api: ModifiedFilesApi = {
      openInIde: async () => Promise.reject(new Error('POST /api/open-in-ide → 401')),
    }
    render(<ModifiedFilesPanel files={files} api={api} toastFailure={(message) => void toasts.push(message)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir apps/web/src/TodoColumn.tsx dans l’IDE' }))
    await waitFor(() => expect(toasts).toEqual([expect.stringContaining('POST /api/open-in-ide → 401')]))
  })
})
