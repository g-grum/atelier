import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import type { Theme } from '@atelier/shared'
import { applyTheme } from '../lib/theme'
import { ThemeToggle } from './ThemeToggle'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})
afterEach(cleanup)

describe('ThemeToggle', () => {
  test('en mode sombre : glyphe ☾ et aria « Passer en mode clair »', () => {
    render(<ThemeToggle patchPreferences={async () => ({})} />)
    const btn = screen.getByRole('button', { name: 'Passer en mode clair' })
    expect(btn.textContent).toBe('☾')
  })

  test('en mode clair : glyphe ☀︎ et aria « Passer en mode sombre »', () => {
    applyTheme('light')
    render(<ThemeToggle patchPreferences={async () => ({})} />)
    const btn = screen.getByRole('button', { name: 'Passer en mode sombre' })
    expect(btn.textContent).toBe('☀︎')
  })

  test('le clic applique le thème immédiatement et PATCH le suivant', async () => {
    const patches: { theme: Theme }[] = []
    render(<ThemeToggle patchPreferences={async (patch) => (patches.push(patch), {})} />)

    fireEvent.click(screen.getByRole('button', { name: 'Passer en mode clair' }))

    // Appliqué localement tout de suite (data-theme posé) + PATCH avec le thème suivant.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    await waitFor(() => expect(patches).toEqual([{ theme: 'light' }]))
    // Le glyphe a suivi le thème appliqué.
    expect(screen.getByRole('button', { name: 'Passer en mode sombre' }).textContent).toBe('☀︎')
  })

  test('si le PATCH échoue : le thème reste appliqué (pas de rollback) et un toast d’erreur s’affiche', async () => {
    const errorSpy = spyOn(toast, 'error').mockImplementation(() => 'id')
    try {
      render(<ThemeToggle patchPreferences={async () => Promise.reject(new Error('PATCH /api/preferences → 500'))} />)

      fireEvent.click(screen.getByRole('button', { name: 'Passer en mode clair' }))

      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
      await waitFor(() => expect(errorSpy).toHaveBeenCalled())
      // Pas de rollback : le thème reste clair malgré l'échec réseau.
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
