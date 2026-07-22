import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionSummary } from '@atelier/shared'
import { DeleteSessionDialog } from './DeleteSessionDialog'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const session: SessionSummary = {
  id: 's1',
  projectId: 'p1',
  name: 'Refresh token expiré',
  updatedAt: '2026-07-15T09:41:00.000Z',
  messageCount: 5,
  isDraft: false,
  model: 'claude-fable-5',
  permissionMode: 'default',
}

function renderDialog(target: SessionSummary | null = session) {
  const calls = { confirmed: [] as SessionSummary[], cancelled: 0 }
  render(
    <DeleteSessionDialog
      session={target}
      onConfirm={(s) => calls.confirmed.push(s)}
      onCancel={() => {
        calls.cancelled += 1
      }}
    />,
  )
  return calls
}

describe('DeleteSessionDialog', () => {
  test('closed when session is null', () => {
    renderDialog(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('shows the definitive warning with the session name', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Supprimer la conversation ?')
    expect(dialog.textContent).toContain('« Refresh token expiré » sera définitivement supprimée.')
  })

  test('a null name falls back to « Nouvelle session »', () => {
    renderDialog({ ...session, name: null })
    expect(screen.getByRole('dialog').textContent).toContain('« Nouvelle session » sera définitivement supprimée.')
  })

  test('Supprimer confirms with the session', () => {
    const calls = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))
    expect(calls.confirmed).toEqual([session])
    expect(calls.cancelled).toBe(0)
  })

  test('Annuler cancels without confirming', () => {
    const calls = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(calls.cancelled).toBe(1)
    expect(calls.confirmed).toEqual([])
  })

  test('Escape closes through onCancel', () => {
    const calls = renderDialog()
    // Radix DismissableLayer listens on ownerDocument — if this ever flakes
    // under happy-dom, dispatch the keydown on `document` instead.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(calls.cancelled).toBe(1)
    expect(calls.confirmed).toEqual([])
  })
})
