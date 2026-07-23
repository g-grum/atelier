import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WidgetInstance } from '@atelier/shared'
import { WidgetFrame } from './WidgetFrame'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const instance: WidgetInstance = { id: 'w1', type: 'rate-limits', span: 2, height: 'M' }

function renderFrame(over: Partial<Parameters<typeof WidgetFrame>[0]> = {}) {
  const changes: WidgetInstance[] = []
  const removed: string[] = []
  render(
    <WidgetFrame
      instance={instance}
      title="Limites du plan"
      onChange={(next) => changes.push(next)}
      onRemove={(id) => removed.push(id)}
      {...over}
    >
      <div>corps du widget</div>
    </WidgetFrame>,
  )
  return { changes, removed }
}

// Radix menus open on POINTERDOWN or Enter/Space keydown — NOT on click —
// and render items async in a portal. House reference: ModelSelector.test.tsx
// (openMenu = keyDown Enter + await findByRole). fireEvent.click on the
// trigger does NOT open the menu.
const openMenu = async () => {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Options du widget' }), { key: 'Enter' })
  await screen.findAllByRole('menuitem')
}

describe('WidgetFrame', () => {
  test('renders heading, body, and span/height classes', () => {
    renderFrame()
    screen.getByRole('heading', { name: 'Limites du plan' })
    screen.getByText('corps du widget')
    const frame = screen.getByRole('group', { name: 'Limites du plan' })
    expect(frame.className).toContain('span-2')
    expect(frame.className).toContain('h-M')
  })

  test('menu: height change emits a patched instance', async () => {
    const { changes } = renderFrame()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hauteur L' }))
    expect(changes).toEqual([{ ...instance, height: 'L' }])
  })

  test('menu: width change emits a patched instance', async () => {
    const { changes } = renderFrame()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Demi-largeur' }))
    expect(changes).toEqual([{ ...instance, span: 1 }])
  })

  test('menu: remove emits the id; configure hidden without onConfigure', async () => {
    const { removed } = renderFrame()
    await openMenu()
    expect(screen.queryByRole('menuitem', { name: 'Configurer…' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retirer' }))
    expect(removed).toEqual(['w1'])
  })
})
