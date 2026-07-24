import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WidgetInstance } from '@atelier/shared'
import { DashboardGrid } from './DashboardGrid'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const layout: WidgetInstance[] = [
  { id: 'a', type: 'rate-limits', span: 2, height: 'M' },
  { id: 'b', type: 'modified-files', span: 1, height: 'S' },
]

function renderGrid(widgets: WidgetInstance[] = layout) {
  const saved: WidgetInstance[][] = []
  render(
    <DashboardGrid
      widgets={widgets}
      onSave={(next) => saved.push(next)}
      renderWidget={(w) => <div data-testid={`body-${w.type}`} />}
    />,
  )
  return { saved }
}

// Radix menus open on keyDown Enter (see ModelSelector.test.tsx) — items are async.
const openMenuOn = async (trigger: HTMLElement) => {
  fireEvent.keyDown(trigger, { key: 'Enter' })
  await screen.findAllByRole('menuitem')
}

describe('DashboardGrid', () => {
  test('renders one framed widget per instance, in order, with registry titles', () => {
    renderGrid()
    const groups = screen.getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Limites du plan', 'Fichiers modifiés — session'])
    screen.getByTestId('body-rate-limits')
    screen.getByTestId('body-modified-files')
  })

  test('remove emits the layout without the widget', async () => {
    const { saved } = renderGrid()
    await openMenuOn(screen.getAllByRole('button', { name: /Options du widget/ })[0]!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retirer' }))
    expect(saved).toEqual([[layout[1]!]])
  })

  test('size change emits the patched layout', async () => {
    const { saved } = renderGrid()
    await openMenuOn(screen.getAllByRole('button', { name: /Options du widget/ })[1]!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hauteur L' }))
    expect(saved).toEqual([[layout[0]!, { ...layout[1]!, height: 'L' }]])
  })

  test('palette: present singletons disabled; adding appends a fresh instance', async () => {
    const { saved } = renderGrid([layout[0]!])
    await openMenuOn(screen.getByRole('button', { name: '+ Widget' }))
    expect(screen.getByRole('menuitem', { name: 'Limites du plan' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fichiers modifiés — session' }))
    expect(saved).toHaveLength(1)
    expect(saved[0]![1]!.type).toBe('modified-files')
  })

  test('palette: multi-instance type stays enabled when present; adding appends another instance', async () => {
    const withPr: WidgetInstance[] = [...layout, { id: 'p1', type: 'github-prs', span: 2, height: 'M', config: { repo: 'o/r' } }]
    const { saved } = renderGrid(withPr)
    await openMenuOn(screen.getByRole('button', { name: '+ Widget' }))
    const item = screen.getByRole('menuitem', { name: 'Pull Requests' })
    expect(item.getAttribute('aria-disabled')).not.toBe('true')
    fireEvent.click(item)
    expect(saved).toHaveLength(1)
    expect(saved[0]!).toHaveLength(4)
    expect(saved[0]![3]!.type).toBe('github-prs')
    expect(saved[0]![3]!.id).not.toBe('p1')
  })

  test('empty layout: only the « + Widget » affordance renders', () => {
    renderGrid([])
    expect(screen.queryAllByRole('group')).toHaveLength(0)
    screen.getByRole('button', { name: '+ Widget' })
  })
})
