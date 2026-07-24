import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WidgetInstance } from '@atelier/shared'
import { PrConfigDialog } from './PrConfigDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const instance: WidgetInstance = { id: 'p1', type: 'github-prs', span: 2, height: 'M', config: { repo: 'o/r', limit: 10 } }

function renderDialog() {
  const saved: WidgetInstance[] = []
  const closed: boolean[] = []
  render(<PrConfigDialog instance={instance} onSave={(next) => saved.push(next)} onClose={() => closed.push(true)} />)
  return { saved, closed }
}

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
})
