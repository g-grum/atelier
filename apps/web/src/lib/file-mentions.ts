/** Un candidat de mention : chemin relatif POSIX, `dir` pour les dossiers (affichés/complétés avec `/`). */
export type FileEntry = { path: string; dir: boolean }

/** Assez pour choisir, pas de scroll infini — même esprit que le popover commandes. */
export const MAX_FILE_MATCHES = 15

/**
 * Le token de mention en cours de frappe, ou null. Déclencheur : un `@` avant
 * le caret, en début de texte ou précédé d'un blanc (évite les emails `a@b`),
 * sans blanc entre le `@` et le caret. Limitation connue (spec) : les chemins
 * contenant des espaces ne re-matchent pas si le caret y revient.
 */
export function mentionPrefix(text: string, caret: number): string | null {
  // Garde caret <= 0 : lastIndexOf clampe un fromIndex négatif à 0, donc sans
  // ça `mentionPrefix('@x', 0)` (caret AVANT le @) ouvrirait le popover à tort.
  if (caret <= 0) return null
  const at = text.lastIndexOf('@', caret - 1)
  if (at === -1) return null
  if (at > 0 && !/\s/.test(text[at - 1]!)) return null
  const token = text.slice(at + 1, caret)
  if (/\s/.test(token)) return null
  return token
}

/**
 * Paliers (comme matchCommands, slash-commands.ts:25) : P1 = chemin OU nom de
 * base COMMENCE par la requête, P2 = chemin CONTIENT, P3 = sous-séquence.
 * Insensible à la casse, ordre d'origine préservé dans chaque palier,
 * plafonné à MAX_FILE_MATCHES. Requête vide : tout matche P1.
 */
export function matchFiles(entries: readonly FileEntry[], prefix: string): FileEntry[] {
  const p = prefix.toLowerCase()
  const starts: FileEntry[] = []
  const contains: FileEntry[] = []
  const subsequence: FileEntry[] = []
  for (const entry of entries) {
    if (starts.length >= MAX_FILE_MATCHES) break
    const path = entry.path.toLowerCase()
    const base = path.slice(path.lastIndexOf('/') + 1)
    if (path.startsWith(p) || base.startsWith(p)) starts.push(entry)
    else if (path.includes(p)) contains.push(entry)
    else if (isSubsequence(p, path)) subsequence.push(entry)
  }
  return [...starts, ...contains, ...subsequence].slice(0, MAX_FILE_MATCHES)
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i++
    if (i >= needle.length) return true
  }
  return needle.length === 0
}

/**
 * Remplace le token `@…` (du `@` au caret) par la mention complète. Fichier :
 * `@chemin ` (espace, la phrase continue). Dossier : `@chemin/` sans espace —
 * le préfixe reste ouvert pour descendre dans l'arborescence.
 */
export function completeMention(text: string, caret: number, entry: FileEntry): { text: string; caret: number } {
  const at = text.lastIndexOf('@', caret - 1)
  const inserted = `@${entry.path}${entry.dir ? '/' : ' '}`
  return {
    text: text.slice(0, at) + inserted + text.slice(caret),
    caret: at + inserted.length,
  }
}

/**
 * Insère une mention `@path` au caret pour un upload (aucun `@` préexistant,
 * contrairement à completeMention). Préfixe un espace si le caractère avant le
 * caret n'est ni un blanc ni le début — sinon `@` collé à un mot violerait la
 * règle « `@` précédé d'un blanc » de mentionPrefix. Suffixe : un espace.
 */
export function insertMention(text: string, caret: number, path: string): { text: string; caret: number } {
  const before = text.slice(0, caret)
  const needsSpace = before.length > 0 && !/\s$/.test(before)
  const inserted = `${needsSpace ? ' ' : ''}@${path} `
  return { text: before + inserted + text.slice(caret), caret: caret + inserted.length }
}
