import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ProjectGithubAccount, WidgetInstance } from '@atelier/shared'
import { PrConfigDialog } from './PrConfigDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const instance: WidgetInstance = { id: 'p1', type: 'github-prs', span: 2, height: 'M', config: { repo: 'o/r', limit: 10 } }

function renderDialog({
  widget = instance,
  githubAccount = null,
}: { widget?: WidgetInstance; githubAccount?: ProjectGithubAccount | null } = {}) {
  const saved: WidgetInstance[] = []
  const closed: boolean[] = []
  const view = render(
    <PrConfigDialog instance={widget} githubAccount={githubAccount} onSave={(next) => saved.push(next)} onClose={() => closed.push(true)} />,
  )
  const rerenderWith = (account: ProjectGithubAccount | null) =>
    view.rerender(
      <PrConfigDialog instance={widget} githubAccount={account} onSave={(next) => saved.push(next)} onClose={() => closed.push(true)} />,
    )
  return { saved, closed, rerenderWith }
}

const repoField = () => screen.getByLabelText('Repo (owner/name)') as HTMLInputElement

describe('PrConfigDialog', () => {
  test('prefills repo and limit', () => {
    renderDialog()
    expect(repoField().value).toBe('o/r')
    expect((screen.getByLabelText('Number of PRs') as HTMLInputElement).value).toBe('10')
  })

  test('clearing the limit field does not snap back — clear-then-retype works, clamp happens at save', () => {
    const { saved } = renderDialog()
    const limitField = screen.getByLabelText('Number of PRs') as HTMLInputElement
    fireEvent.change(limitField, { target: { value: '' } })
    expect(limitField.value).toBe('') // no snap-back to 10 mid-edit
    fireEvent.change(limitField, { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saved[0]!.config).toEqual({ repo: 'o/r', limit: 25 })
  })

  test('an emptied limit falls back to 10 at save, out-of-range clamps', () => {
    const { saved } = renderDialog()
    fireEvent.change(screen.getByLabelText('Number of PRs'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saved[0]!.config).toEqual({ repo: 'o/r', limit: 10 })
  })

  test('save emits the patched instance and closes', () => {
    const { saved, closed } = renderDialog()
    fireEvent.change(repoField(), { target: { value: 'acme-corp/demoapp-backend' } })
    fireEvent.change(screen.getByLabelText('Number of PRs'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saved).toEqual([{ ...instance, config: { repo: 'acme-corp/demoapp-backend', limit: 5 } }])
    expect(closed).toEqual([true])
  })

  test('invalid repo shows the error and does not save', () => {
    const { saved } = renderDialog()
    fireEvent.change(repoField(), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    screen.getByText(/owner\/repo/)
    expect(saved).toEqual([])
  })

  const fresh: WidgetInstance = { ...instance, config: { repo: '', limit: 10 } }

  test('empty repo: prefilled from the data already cached (topbar chip)', () => {
    renderDialog({ widget: fresh, githubAccount: { account: 'g-grum', repo: 'g-grum/atelier' } })
    expect(repoField().value).toBe('g-grum/atelier')
  })

  test('repo already configured: the configured value stays', () => {
    renderDialog({ githubAccount: { account: 'x', repo: 'autre/repo' } })
    expect(repoField().value).toBe('o/r')
  })

  test('remote without a derivable repo (repo null): the field stays empty', () => {
    renderDialog({ widget: fresh, githubAccount: { account: 'g-grum', repo: null } })
    expect(repoField().value).toBe('')
  })

  test('no data (no open project / query not resolved yet): no prefill', () => {
    renderDialog({ widget: fresh, githubAccount: null })
    expect(repoField().value).toBe('')
  })

  test('data arriving after opening: prefills while the field is empty', () => {
    const { rerenderWith } = renderDialog({ widget: fresh, githubAccount: null })
    rerenderWith({ account: 'x', repo: 'arrive/tard' })
    expect(repoField().value).toBe('arrive/tard')
  })

  test('user input is not overwritten by late data', () => {
    const { rerenderWith } = renderDialog({ widget: fresh, githubAccount: null })
    fireEvent.change(repoField(), { target: { value: 'tape/avant' } })
    rerenderWith({ account: 'x', repo: 'trop/tard' })
    expect(repoField().value).toBe('tape/avant')
  })
})
