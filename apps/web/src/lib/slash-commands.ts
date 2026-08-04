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

/**
 * Recherche par paliers (spec 2026-08-04) : P1 = nom/alias COMMENCE par la
 * requête, P2 = nom/alias CONTIENT, P3 = description CONTIENT. Insensible à
 * la casse. Chaque commande apparaît une seule fois, dans son meilleur
 * palier ; l'ordre d'origine est préservé à l'intérieur d'un palier (une
 * seule passe, pas de sort à score). Requête vide : tout matche P1 — le
 * catalogue complet sort dans l'ordre d'origine, sans cas spécial.
 */
export function matchCommands(commands: readonly SlashCommandInfo[], prefix: string): SlashCommandInfo[] {
  const p = prefix.toLowerCase()
  const starts: SlashCommandInfo[] = []
  const contains: SlashCommandInfo[] = []
  const described: SlashCommandInfo[] = []
  for (const command of commands) {
    const names = [command.name, ...command.aliases].map((n) => n.toLowerCase())
    if (names.some((n) => n.startsWith(p))) starts.push(command)
    else if (names.some((n) => n.includes(p))) contains.push(command)
    else if (command.description.toLowerCase().includes(p)) described.push(command)
  }
  return [...starts, ...contains, ...described]
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
