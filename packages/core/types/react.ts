import type { CSSProperties, Ref } from 'react'

/** Props of a component whose outer element accepts styling from its parent. */
export type Stylable = { className?: string; style?: CSSProperties }

/** Adds a forwarded ref to a component's props. */
export type PropsWithRef<P, T extends HTMLElement = HTMLElement> = P & {
  ref?: Ref<T>
}
