import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionPermissionMode } from '@atelier/shared'
import { ModeSelector, MODES } from '@/features/chat/components/composer/ModeSelector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

function renderSelector(mode: SessionPermissionMode = 'default', disabled = false) {
  const changes: SessionPermissionMode[] = []
  render(<ModeSelector mode={mode} disabled={disabled} onChange={(m) => changes.push(m)} />)
  return { changes }
}

describe('ModeSelector', () => {
  test('shows the current mode label and opens the 4-option listbox', () => {
    renderSelector('default')
    const button = screen.getByRole('button', { name: 'Permission mode: Auto' })
    fireEvent.click(button)

    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(MODES.map((m) => `${m.label}${m.description}`))
    expect(screen.getByRole('option', { name: /^Auto\b/ }).getAttribute('aria-selected')).toBe('true')
  })

  test('selecting another mode emits the change and closes the popover', () => {
    const { changes } = renderSelector('default')
    fireEvent.click(screen.getByRole('button', { name: 'Permission mode: Auto' }))
    fireEvent.click(screen.getByRole('option', { name: /Accept edits/ }))

    expect(changes).toEqual(['acceptEdits'])
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  test('re-selecting the current mode closes without emitting', () => {
    const { changes } = renderSelector('plan')
    fireEvent.click(screen.getByRole('button', { name: 'Permission mode: Plan' }))
    fireEvent.click(screen.getByRole('option', { name: /Plan/ }))

    expect(changes).toEqual([])
  })

  test('the dangerous mode styles the trigger in red (danger class)', () => {
    renderSelector('bypassPermissions')
    const button = screen.getByRole('button', { name: 'Permission mode: Skip perms' })
    expect(button.className).toContain('danger')
  })

  test('disabled selector cannot open', () => {
    renderSelector('default', true)
    const button = screen.getByRole('button', { name: 'Permission mode: Auto' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})
