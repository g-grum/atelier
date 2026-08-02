import type { SlashCommandInfo } from '@atelier/shared'

/**
 * Le token de commande en cours de frappe, ou null si le brouillon n'est pas
 * un préfixe de slash command. Déclenchement volontairement STRICT : le
 * brouillon doit commencer par '/' (position 0) et le curseur rester dans le
 * premier mot — sinon `src/foo` ou une URL ouvrirait le popover en pleine phrase.
 */
export function commandPrefix(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null
  const firstBreak = text.search(/\s/)
  const tokenEnd = firstBreak === -1 ? text.length : firstBreak
  if (caret > tokenEnd) return null
  return text.slice(1, tokenEnd)
}

/** Filtre par préfixe sur le nom ET sur les alias (les commandes réelles sont namespacées). */
export function matchCommands(commands: readonly SlashCommandInfo[], prefix: string): SlashCommandInfo[] {
  const p = prefix.toLowerCase()
  return commands.filter(
    (c) => c.name.toLowerCase().startsWith(p) || c.aliases.some((a) => a.toLowerCase().startsWith(p)),
  )
}

/**
 * Remplace le PREMIER TOKEN seulement, en préservant le reste du brouillon —
 * une réécriture complète perdrait l'argument déjà tapé (cas réel : le curseur
 * peut revenir dans `review` sur `/review mon-fichier`).
 */
export function completeCommand(text: string, name: string): string {
  const firstBreak = text.search(/\s/)
  return firstBreak === -1 ? `/${name} ` : `/${name}${text.slice(firstBreak)}`
}
