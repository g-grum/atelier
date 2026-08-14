import { toast } from 'sonner'
import type { Theme } from '@atelier/shared'
import { applyTheme, toggleValue, useThemeValue } from '../lib/theme'

export type ThemeToggleProps = {
  patchPreferences: (patch: { theme: Theme }) => Promise<unknown>
}

/**
 * Bascule ☀︎/☾ dans la topbar. Le glyphe suit `data-theme` (source de vérité)
 * donc il ne peut jamais diverger du thème appliqué. Mise à jour optimiste :
 * on applique localement AVANT le PATCH ; en cas d'échec réseau le thème reste
 * appliqué (pas de rollback) et un toast d'erreur prévient l'utilisateur.
 */
export function ThemeToggle({ patchPreferences }: ThemeToggleProps) {
  const theme = useThemeValue()
  const dark = theme === 'dark'

  return (
    <button
      type="button"
      className="theme-btn"
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => {
        const next = toggleValue(theme)
        applyTheme(next)
        patchPreferences({ theme: next }).catch(() => toast.error('Could not save the theme.'))
      }}
    >
      {dark ? '☾' : '☀︎'}
    </button>
  )
}
