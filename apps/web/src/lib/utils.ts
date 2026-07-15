import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Last segment of a POSIX path — project display names come from folder paths. */
export function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}
