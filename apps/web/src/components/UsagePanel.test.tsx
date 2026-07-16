import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import type { ServerEvent } from '@atelier/shared'
import { initialState, reduce } from '../state/stream-reducer'
import { UsagePanel, formatTokens } from './UsagePanel'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

// The number–unit separator is a no-break space (French typography).
const NB = '\u00A0'

describe('formatTokens', () => {
  test('below a thousand: the plain number', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(486)).toBe('486')
    expect(formatTokens(999)).toBe('999')
  })

  test('thousands: « k » with a French decimal comma under 10 k', () => {
    expect(formatTokens(1000)).toBe(`1${NB}k`)
    expect(formatTokens(2413)).toBe(`2,4${NB}k`)
    expect(formatTokens(9950)).toBe(`10${NB}k`)
    expect(formatTokens(128000)).toBe(`128${NB}k`)
    expect(formatTokens(999499)).toBe(`999${NB}k`)
  })

  test('millions: « M », never « 1000 k »', () => {
    expect(formatTokens(999500)).toBe(`1${NB}M`)
    expect(formatTokens(1250000)).toBe(`1,3${NB}M`)
    expect(formatTokens(12800000)).toBe(`13${NB}M`)
  })
})

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): ServerEvent => ({ type: 'usage', sessionId: 'ses-1', inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens })

/** Full text of the .kv row that carries the given label. */
function row(label: string): string {
  return screen.getByText(label).parentElement!.textContent ?? ''
}

describe('UsagePanel', () => {
  test('renders the counters ACCUMULATED across usage events by the real reducer', () => {
    const state = [usage(2413, 486, 1820, 0), usage(125587, 2014, 180, 219)].reduce(reduce, initialState())
    render(<UsagePanel tokens={state.sessionTokens} />)

    screen.getByText('Usage — session')
    expect(row('Entrée')).toBe(`Entrée128${NB}k`)
    expect(row('Sortie')).toBe(`Sortie2,5${NB}k`)
    expect(row('Cache (lecture)')).toBe(`Cache (lecture)2${NB}k`)
    expect(row('Cache (écriture)')).toBe('Cache (écriture)219')
    // 128000 + 2500 + 2000 + 219 = 132719
    expect(row('Total')).toBe(`Total133${NB}k`)
  })

  test('a fresh session shows all-zero counters (honest empty state)', () => {
    render(<UsagePanel tokens={initialState().sessionTokens} />)
    for (const label of ['Entrée', 'Sortie', 'Cache (lecture)', 'Cache (écriture)', 'Total']) {
      expect(row(label)).toBe(`${label}0`)
    }
  })
})
