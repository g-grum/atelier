import { useEffect, useMemo, useState } from 'react'
import { TOUR_STEPS } from '@/features/onboarding/components/tour/tour-steps'

export type TourProps = {
  /** Called exactly once when the tour ends — Done, Skip or Escape all persist the flag (spec 2026-08-18). */
  onFinish: () => void
}

/**
 * First-launch coach marks: a dimmed backdrop plus one positioned popover per
 * step. A plain positioned div rather than a Radix Popover — the constraint is
 * "no new dependency + theme-consistent", and Radix anchoring adds nothing for
 * 4 static steps. Anchors are resolved lazily; a missing anchor (layout
 * changed) skips its step rather than crashing.
 */
export function Tour({ onFinish }: TourProps) {
  const [index, setIndex] = useState(0)

  // First step at or after `index` whose anchor exists in the DOM.
  const resolved = useMemo(() => {
    for (let i = index; i < TOUR_STEPS.length; i++) {
      const step = TOUR_STEPS[i]
      if (step === undefined) continue
      const el = document.querySelector(step.anchor)
      if (el !== null) return { i, step, rect: el.getBoundingClientRect() }
    }
    return null
  }, [index])

  // Ran out of anchored steps (nothing to anchor to at all) → finish. Effect,
  // not a render-time call: onFinish sets parent state.
  const exhausted = resolved === null
  useEffect(() => {
    if (exhausted) onFinish()
  }, [exhausted, onFinish])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onFinish()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onFinish])

  if (resolved === null) return null
  const { i, step, rect } = resolved
  const isLast = TOUR_STEPS.slice(i + 1).every((s) => document.querySelector(s.anchor) === null)

  // Clamped fixed position next to the anchor — simple and robust across the
  // 3-zone layout; no collision library for 4 static steps (YAGNI).
  const top = Math.min(Math.max(rect.top + 16, 16), window.innerHeight - 200)
  const left = Math.min(Math.max(rect.right + 16, 16), window.innerWidth - 296)

  return (
    <div className="tour-backdrop">
      <div className="tour-pop" role="dialog" aria-label={step.title} style={{ top, left }}>
        <h2>{step.title}</h2>
        <p>{step.body}</p>
        <footer>
          <span className="tour-count">{`${i + 1}/${TOUR_STEPS.length}`}</span>
          {!isLast && (
            <button type="button" className="banner-btn" onClick={onFinish}>
              Skip
            </button>
          )}
          <button type="button" className="new-btn" onClick={() => (isLast ? onFinish() : setIndex(i + 1))}>
            {isLast ? 'Done' : 'Next'}
          </button>
        </footer>
      </div>
    </div>
  )
}
