import { useSyncExternalStore } from 'react'
import type { Theme } from '@atelier/shared'

/** Clé du cache anti-flash — lue aussi par le script inline de index.html (garder les deux synchrones). */
export const THEME_STORAGE_KEY = 'atelier:theme'

/** Pose le thème sur <html> et resynchronise le cache. Absent = dark (spec). */
export function applyTheme(theme: Theme): void {
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light')
  else document.documentElement.removeAttribute('data-theme')
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // localStorage indisponible : le thème s'applique quand même, seul l'anti-flash au prochain boot est perdu.
  }
}

export function cachedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function toggleValue(theme: Theme): Theme {
  return theme === 'light' ? 'dark' : 'light'
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

/** Thème appliqué (source de vérité = l'attribut data-theme sur <html>). Absent = dark. */
export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

/** Thème courant, réactif — suit data-theme quel que soit l'endroit qui l'a posé (toggle, settings, resync). */
export function useThemeValue(): Theme {
  return useSyncExternalStore(subscribe, currentTheme)
}
