import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_WIDGETS,
  isServerEvent,
  parseClientMessage,
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
