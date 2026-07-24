import { readFileSync } from 'node:fs'

/** Valeurs du token --t-ground du mockup v5.0 — cohérentes avec styles.css. */
export const GROUND_DARK = '#101014'
export const GROUND_LIGHT = '#fafafa'

/** Fond de fenêtre avant le premier paint : lit le thème persisté dans app-data.json. Toute erreur → dark. */
export function readThemeGround(appDataPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(appDataPath, 'utf8')) as { preferences?: { theme?: string } }
    return parsed.preferences?.theme === 'light' ? GROUND_LIGHT : GROUND_DARK
  } catch {
    return GROUND_DARK
  }
}
