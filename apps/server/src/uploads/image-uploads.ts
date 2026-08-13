/** MIME image supportés → extension de fichier (spec 2026-08-13). */
export const ALLOWED_IMAGE_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** Plafond de taille d'une image uploadée. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Extension pour un MIME image supporté, ou null. */
export function extensionForMime(mime: string): string | null {
  return ALLOWED_IMAGE_MIME[mime] ?? null
}
