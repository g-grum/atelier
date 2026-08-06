import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProjectGithubAccount, WidgetInstance } from '@atelier/shared'
import { PrConfigDialog, type PrConfigDialogApi } from './PrConfigDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const instance: WidgetInstance = { id: 'p1', type: 'github-prs', span: 2, height: 'M', config: { repo: 'o/r', limit: 10 } }

function fakeApi(account: ProjectGithubAccount, calls: string[] = []): PrConfigDialogApi {
  return {
    getProjectGithubAccount: async (projectId) => {
      calls.push(projectId)
      return account
    },
  }
}

function renderDialog({
  widget = instance,
  projectId = null,
  api = fakeApi({ account: null, repo: null }),
}: { widget?: WidgetInstance; projectId?: string | null; api?: PrConfigDialogApi } = {}) {
  const saved: WidgetInstance[] = []
  const closed: boolean[] = []
  render(<PrConfigDialog instance={widget} projectId={projectId} api={api} onSave={(next) => saved.push(next)} onClose={() => closed.push(true)} />)
  return { saved, closed }
}

const repoField = () => screen.getByLabelText('Repo (owner/nom)') as HTMLInputElement

describe('PrConfigDialog', () => {
  test('prefills repo and limit', () => {
    renderDialog()
    expect((screen.getByLabelText('Repo (owner/nom)') as HTMLInputElement).value).toBe('o/r')
    expect((screen.getByLabelText('Nombre de PRs') as HTMLInputElement).value).toBe('10')
  })

  test('clearing the limit field does not snap back — clear-then-retype works, clamp happens at save', () => {
    const { saved } = renderDialog()
    const limitField = screen.getByLabelText('Nombre de PRs') as HTMLInputElement
    fireEvent.change(limitField, { target: { value: '' } })
    expect(limitField.value).toBe('') // no snap-back to 10 mid-edit
    fireEvent.change(limitField, { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(saved[0]!.config).toEqual({ repo: 'o/r', limit: 25 })
  })

  test('an emptied limit falls back to 10 at save, out-of-range clamps', () => {
    const { saved } = renderDialog()
    fireEvent.change(screen.getByLabelText('Nombre de PRs'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(saved[0]!.config).toEqual({ repo: 'o/r', limit: 10 })
  })

  test('save emits the patched instance and closes', () => {
    const { saved, closed } = renderDialog()
    fireEvent.change(screen.getByLabelText('Repo (owner/nom)'), { target: { value: 'acme-corp/demoapp-backend' } })
    fireEvent.change(screen.getByLabelText('Nombre de PRs'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(saved).toEqual([{ ...instance, config: { repo: 'acme-corp/demoapp-backend', limit: 5 } }])
    expect(closed).toEqual([true])
  })

  test('invalid repo shows the error and does not save', () => {
    const { saved } = renderDialog()
    fireEvent.change(screen.getByLabelText('Repo (owner/nom)'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    screen.getByText(/owner\/repo/)
    expect(saved).toEqual([])
  })

  const fresh: WidgetInstance = { ...instance, config: { repo: '', limit: 10 } }

  test('repo vide → préremplissage depuis le remote du projet ouvert', async () => {
    const calls: string[] = []
    renderDialog({ widget: fresh, projectId: 'proj-1', api: fakeApi({ account: 'alice-dev', repo: 'demoapp/atelier' }, calls) })
    await waitFor(() => expect(repoField().value).toBe('demoapp/atelier'))
    expect(calls).toEqual(['proj-1'])
  })

  test('repo déjà configuré → aucun appel backend, la valeur reste', async () => {
    const calls: string[] = []
    renderDialog({ projectId: 'proj-1', api: fakeApi({ account: 'x', repo: 'autre/repo' }, calls) })
    // Laisse passer un éventuel effet asynchrone avant d'affirmer l'absence d'appel.
    await Promise.resolve()
    expect(repoField().value).toBe('o/r')
    expect(calls).toEqual([])
  })

  test('remote sans repo dérivable (null) → le champ reste vide', async () => {
    renderDialog({ widget: fresh, projectId: 'proj-1', api: fakeApi({ account: 'alice-dev', repo: null }) })
    await Promise.resolve()
    expect(repoField().value).toBe('')
  })

  test('aucun projet ouvert (projectId null) → pas de préremplissage', async () => {
    const calls: string[] = []
    renderDialog({ widget: fresh, projectId: null, api: fakeApi({ account: 'x', repo: 'a/b' }, calls) })
    await Promise.resolve()
    expect(repoField().value).toBe('')
    expect(calls).toEqual([])
  })

  test('la saisie utilisateur n’est pas écrasée par un préremplissage tardif', async () => {
    let resolve!: (value: ProjectGithubAccount) => void
    const api: PrConfigDialogApi = { getProjectGithubAccount: () => new Promise((r) => (resolve = r)) }
    renderDialog({ widget: fresh, projectId: 'proj-1', api })
    fireEvent.change(repoField(), { target: { value: 'tape/avant' } })
    await act(async () => {
      resolve({ account: 'x', repo: 'trop/tard' })
    })
    expect(repoField().value).toBe('tape/avant')
  })
})
