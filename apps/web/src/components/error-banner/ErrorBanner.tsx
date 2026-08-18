import type { StreamState } from '@/stores/stream-reducer'

export type ErrorBannerProps = {
  status: StreamState['status']
  error: StreamState['error']
}

/**
 * Turn-fatal error banner (red = critical states; amber stays reserved for
 * permissions). Mounted ABOVE the messages in the chat column — the
 * conversation stays mounted and readable below it. The usage-limit case
 * carries resetAt (spec): show the local reset time, not the machine reason.
 */
export function ErrorBanner({ status, error }: ErrorBannerProps) {
  if (status !== 'error' || error === undefined) return null
  return (
    <div className="banner" role="alert">
      <span className="banner-text">{message(error)}</span>
    </div>
  )
}

function message(error: NonNullable<StreamState['error']>): string {
  if (error.resetAt !== undefined) {
    const at = new Date(error.resetAt)
    // An unparseable resetAt falls through to the time-less cases below.
    if (!Number.isNaN(at.getTime())) {
      const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
      return `Usage limit reached — resets at ${hhmm}`
    }
  }
  // The machine slug must never leak into the French UI: a usage_limit without
  // a (parseable) resetAt still reads as the human message, just time-less.
  if (error.reason === 'usage_limit') return 'Usage limit reached'
  return error.reason
}
