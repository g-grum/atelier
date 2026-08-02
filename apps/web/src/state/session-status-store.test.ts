import { describe, expect, it } from 'bun:test'
import { SessionStatusStore } from './session-status-store'

const ev = (sessionId: string, state: 'idle' | 'streaming' | 'error') => ({ type: 'session_status' as const, sessionId, state })

describe('SessionStatusStore', () => {
  it('streaming → statuses=streaming, pas de waiting', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'streaming'))
    expect(s.getSnapshot().statuses.get('a')).toBe('streaming')
    expect(s.getSnapshot().waiting.has('a')).toBe(false)
  })

  it('streaming → idle hors focus ⇒ waiting', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'streaming'))
    s.handle(ev('a', 'idle'))
    expect(s.getSnapshot().waiting.has('a')).toBe(true)
  })

  it('streaming → error hors focus ⇒ waiting (règle 3bis)', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'streaming'))
    s.handle(ev('a', 'error'))
    expect(s.getSnapshot().waiting.has('a')).toBe(true)
  })

  it('snapshot initial de sessions déjà idle ⇒ jamais waiting (pas de transition depuis streaming)', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'idle'))
    s.handle(ev('b', 'idle'))
    expect(s.getSnapshot().waiting.size).toBe(0)
  })

  it('→ idle SUR la session focalisée ⇒ pas de waiting', () => {
    const s = new SessionStatusStore()
    s.setActive('a')
    s.handle(ev('a', 'streaming'))
    s.handle(ev('a', 'idle'))
    expect(s.getSnapshot().waiting.has('a')).toBe(false)
  })

  it('→ streaming vide le waiting (le vert prime)', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'streaming'))
    s.handle(ev('a', 'idle'))
    s.handle(ev('a', 'streaming'))
    expect(s.getSnapshot().waiting.has('a')).toBe(false)
  })

  it('setActive vide le waiting de la session focalisée', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'streaming'))
    s.handle(ev('a', 'idle'))
    s.setActive('a')
    expect(s.getSnapshot().waiting.has('a')).toBe(false)
  })

  it('getSnapshot est stable tant que rien ne change (useSyncExternalStore)', () => {
    const s = new SessionStatusStore()
    const first = s.getSnapshot()
    expect(s.getSnapshot()).toBe(first)
    s.handle(ev('a', 'streaming'))
    expect(s.getSnapshot()).not.toBe(first)
  })

  it('notifie les abonnés à chaque mutation', () => {
    const s = new SessionStatusStore()
    let n = 0
    s.subscribe(() => { n++ })
    s.handle(ev('a', 'streaming'))
    expect(n).toBe(1)
  })
})
