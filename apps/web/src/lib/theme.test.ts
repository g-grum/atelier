import { describe, expect, test, beforeEach } from 'bun:test'
import { THEME_STORAGE_KEY, applyTheme, cachedTheme, toggleValue } from './theme'

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
})
