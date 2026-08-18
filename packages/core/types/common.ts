/** A value that may be absent — API fields, optional lookups, uninitialised state. */
export type Maybe<T> = T | null | undefined

/** A string-keyed map. Prefer this over inlining `Record<string, T>`. */
export type Dictionary<T = string> = Record<string, T>

/** Narrows the listed keys of `T` to their non-nullable form, leaving the rest untouched. */
export type NonNullableProps<T, K extends keyof T = keyof T> = {
  [P in keyof T]: P extends K ? NonNullable<T[P]> : T[P]
}
