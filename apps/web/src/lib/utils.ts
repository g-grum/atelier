import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Last segment of a POSIX path — project display names come from folder paths. */
export function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

/** Human-readable message from an unknown thrown value (fetch/mutation failures). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}
