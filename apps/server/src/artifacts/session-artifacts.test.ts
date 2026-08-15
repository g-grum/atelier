import { describe, expect, test } from 'bun:test'
import type { StatusHubEvent } from '@atelier/shared'
import { SessionArtifactsTracker } from './session-artifacts'

function makeTracker(existing: string[] = ['/proj/shots/home.png', '/proj/shots/next.png']) {
  const published: StatusHubEvent[] = []
  let tick = 0
  const tracker = new SessionArtifactsTracker({
    publish: (event) => published.push(event),
    fileExists: (abs) => existing.includes(abs),
    now: () => `2026-08-14T10:0${tick++}:00.000Z`,
  })
  return { tracker, published }
}

describe('SessionArtifactsTracker', () => {
  test('Write of an existing image under the root publishes artifacts_status', () => {
    const { tracker, published } = makeTracker()
    tracker.onToolUse('s1', 'p1', '/proj', 'Write', { file_path: '/proj/shots/home.png' })
    expect(published).toEqual([
      {
        type: 'artifacts_status',
        sessionId: 's1',
        projectId: 'p1',
        artifacts: [{ path: 'shots/home.png', addedAt: '2026-08-14T10:00:00.000Z' }],
      },
    ])
  })

  test('non-image, missing file, or path escaping the root publish nothing', () => {
    const { tracker, published } = makeTracker()
    tracker.onToolUse('s1', 'p1', '/proj', 'Write', { file_path: '/proj/src/index.ts' })
    tracker.onToolUse('s1', 'p1', '/proj', 'Write', { file_path: '/proj/shots/ghost.png' })
    tracker.onToolUse('s1', 'p1', '/proj', 'Write', { file_path: '/etc/evil.png' })
    expect(published).toEqual([])
  })

  test('same path again refreshes addedAt without duplicating the entry', () => {
    const { tracker, published } = makeTracker()
    tracker.onToolUse('s1', 'p1', '/proj', 'Write', { file_path: '/proj/shots/home.png' })
    tracker.onToolUse('s1', 'p1', '/proj', 'Bash', { command: 'open shots/home.png' })
    const last = published.at(-1)
    expect(published).toHaveLength(2)
    expect(last).toEqual({
      type: 'artifacts_status',
      sessionId: 's1',
      projectId: 'p1',
      artifacts: [{ path: 'shots/home.png', addedAt: '2026-08-14T10:01:00.000Z' }],
    })
  })

  test('artifacts are per-session; get() returns the current list', () => {
    const { tracker } = makeTracker()
    tracker.onToolUse('s1', 'p1', '/proj', 'Write', { file_path: '/proj/shots/home.png' })
    tracker.onToolUse('s2', 'p1', '/proj', 'Write', { file_path: '/proj/shots/next.png' })
    expect(tracker.get('s1').map((a) => a.path)).toEqual(['shots/home.png'])
    expect(tracker.get('s2').map((a) => a.path)).toEqual(['shots/next.png'])
    expect(tracker.get('unknown')).toEqual([])
  })

  test('a Bash command may add several images at once (single publish)', () => {
    const { tracker, published } = makeTracker()
    tracker.onToolUse('s1', 'p1', '/proj', 'Bash', { command: 'cp shots/home.png shots/next.png' })
    expect(published).toHaveLength(1)
    expect(tracker.get('s1').map((a) => a.path)).toEqual(['shots/home.png', 'shots/next.png'])
  })
})
