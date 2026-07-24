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
