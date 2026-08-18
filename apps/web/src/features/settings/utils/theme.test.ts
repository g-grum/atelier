import { afterEach, describe, expect, test, beforeEach } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { THEME_STORAGE_KEY, applyTheme, cachedTheme, currentTheme, toggleValue, useThemeValue } from '@/features/settings/utils/theme'

// RTL wraps renders in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  test('applyTheme("light") pose data-theme et met à jour le cache', () => {
    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  test('applyTheme("dark") retire data-theme (absent = dark) et met à jour le cache', () => {
    applyTheme('light')
    applyTheme('dark')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  test('cachedTheme : valeur inconnue ou absente → dark', () => {
    expect(cachedTheme()).toBe('dark')
    localStorage.setItem(THEME_STORAGE_KEY, 'zebra')
    expect(cachedTheme()).toBe('dark')
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    expect(cachedTheme()).toBe('light')
  })

  test('toggleValue alterne', () => {
    expect(toggleValue('dark')).toBe('light')
    expect(toggleValue('light')).toBe('dark')
  })

  test('currentTheme lit l\'attribut data-theme (absent = dark)', () => {
    expect(currentTheme()).toBe('dark')
    applyTheme('light')
    expect(currentTheme()).toBe('light')
  })
})

describe('useThemeValue', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })
  afterEach(cleanup)

  test('reflète le thème courant au montage', () => {
    applyTheme('light')
    const { result } = renderHook(() => useThemeValue())
    expect(result.current).toBe('light')
  })

  test('se met à jour quand data-theme change en dehors du composant', async () => {
    const { result } = renderHook(() => useThemeValue())
    expect(result.current).toBe('dark')

    // Un changement de thème posé ailleurs (settings, resync) doit propager.
    act(() => applyTheme('light'))
    await waitFor(() => expect(result.current).toBe('light'))
  })
})
