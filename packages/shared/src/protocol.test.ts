import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_WIDGETS,
  isServerEvent,
  parseClientMessage,
  parseSessionStatus,
  parseStatusHubEvent,
  REPO_PATTERN,
  type ServerEvent,
} from './protocol'

describe('protocol guards', () => {
  test('accepts a valid assistant_delta', () => {
    const event: ServerEvent = { type: 'assistant_delta', sessionId: 's1', text: 'hey' }
    expect(isServerEvent(event)).toBe(true)
  })

  test('rejects unknown event types', () => {
    expect(isServerEvent({ type: 'nope' })).toBe(false)
  })

  test('parses a user_message client frame', () => {
    const parsed = parseClientMessage(JSON.stringify({ type: 'user_message', text: 'hi' }))
    expect(parsed).toEqual({ type: 'user_message', text: 'hi' })
  })

  test('returns null for malformed JSON', () => {
    expect(parseClientMessage('{oops')).toBeNull()
  })
})

describe('question protocol', () => {
  test('parseClientMessage accepte question_response avec answers', () => {
    const raw = JSON.stringify({ type: 'question_response', requestId: 'q1', answers: { 'Quelle lib ?': 'React' } })
    expect(parseClientMessage(raw)).toEqual({ type: 'question_response', requestId: 'q1', answers: { 'Quelle lib ?': 'React' } })
  })

  test('parseClientMessage accepte question_response sans answers (dismiss)', () => {
    const raw = JSON.stringify({ type: 'question_response', requestId: 'q1' })
    expect(parseClientMessage(raw)).toEqual({ type: 'question_response', requestId: 'q1' })
  })

  test('isServerEvent accepte question_request', () => {
    expect(
      isServerEvent({ type: 'question_request', sessionId: 's1', requestId: 'q1', questions: [] }),
    ).toBe(true)
  })
})

describe('isServerEvent', () => {
  test('accepte un événement commands', () => {
    expect(isServerEvent({ type: 'commands', sessionId: 's1', commands: [] })).toBe(true)
  })
})

describe('widget contracts', () => {
  test('DEFAULT_WIDGETS mirrors the current aside: rate-limits then modified-files, full width, height M', () => {
    expect(DEFAULT_WIDGETS.map((w) => w.type)).toEqual(['rate-limits', 'modified-files'])
    for (const w of DEFAULT_WIDGETS) {
      expect(w.span).toBe(2)
      expect(w.height).toBe('M')
      expect(w.config).toBeUndefined()
    }
  })

  test('REPO_PATTERN accepts owner/repo and rejects everything else', () => {
    expect(REPO_PATTERN.test('acme-corp/demoapp-frontend')).toBe(true)
    expect(REPO_PATTERN.test('a.b-c_d/e.f-g_h')).toBe(true)
    expect(REPO_PATTERN.test('no-slash')).toBe(false)
    expect(REPO_PATTERN.test('a/b/c')).toBe(false)
    expect(REPO_PATTERN.test('owner/repo?x=1')).toBe(false)
  })
})

describe('parseSessionStatus', () => {
  test('accepte un évènement bien formé', () => {
    expect(parseSessionStatus(JSON.stringify({ type: 'session_status', sessionId: 's1', state: 'streaming' })))
      .toEqual({ type: 'session_status', sessionId: 's1', state: 'streaming' })
  })
  test('rejette un mauvais type, un état inconnu, un sessionId non-string ou un JSON invalide', () => {
    expect(parseSessionStatus(JSON.stringify({ type: 'status', sessionId: 's1', state: 'idle' }))).toBeNull()
    expect(parseSessionStatus(JSON.stringify({ type: 'session_status', sessionId: 's1', state: 'busy' }))).toBeNull()
    expect(parseSessionStatus(JSON.stringify({ type: 'session_status', sessionId: 42, state: 'idle' }))).toBeNull()
    expect(parseSessionStatus('{not json')).toBeNull()
  })
})

describe('parseStatusHubEvent', () => {
  test('accepte session_status (comportement historique)', () => {
    expect(parseStatusHubEvent(JSON.stringify({ type: 'session_status', sessionId: 's1', state: 'idle' })))
      .toEqual({ type: 'session_status', sessionId: 's1', state: 'idle' })
  })

  test('accepte autopilot_status avec un état complet', () => {
    const autopilot = { run: null, items: [] }
    expect(parseStatusHubEvent(JSON.stringify({ type: 'autopilot_status', autopilot })))
      .toEqual({ type: 'autopilot_status', autopilot })
  })

  test('rejette le reste', () => {
    expect(parseStatusHubEvent(JSON.stringify({ type: 'nope' }))).toBeNull()
    expect(parseStatusHubEvent(JSON.stringify({ type: 'autopilot_status' }))).toBeNull()
    expect(parseStatusHubEvent('pas du json')).toBeNull()
  })
})

describe('parseStatusHubEvent — artifacts & dev servers', () => {
  test('accepts artifacts_status with a full payload', () => {
    const artifacts = [{ path: 'shots/home.png', addedAt: '2026-08-14T10:00:00Z' }]
    expect(parseStatusHubEvent(JSON.stringify({ type: 'artifacts_status', sessionId: 's1', projectId: 'p1', artifacts })))
      .toEqual({ type: 'artifacts_status', sessionId: 's1', projectId: 'p1', artifacts })
  })

  test('accepts dev_servers_status with a full payload', () => {
    const servers = [{ port: 4518, pid: 123, label: 'vite', command: 'bun run dev', killable: true }]
    expect(parseStatusHubEvent(JSON.stringify({ type: 'dev_servers_status', servers })))
      .toEqual({ type: 'dev_servers_status', servers })
  })

  test('rejects malformed artifacts/dev-servers events', () => {
    expect(parseStatusHubEvent(JSON.stringify({ type: 'artifacts_status', sessionId: 's1' }))).toBeNull()
    expect(parseStatusHubEvent(JSON.stringify({ type: 'artifacts_status', projectId: 'p1', artifacts: [] }))).toBeNull()
    expect(parseStatusHubEvent(JSON.stringify({ type: 'dev_servers_status' }))).toBeNull()
    expect(parseStatusHubEvent(JSON.stringify({ type: 'dev_servers_status', servers: 'nope' }))).toBeNull()
  })
})
