import { describe, expect, test } from 'bun:test'
import {
  isServerEvent,
  parseClientMessage,
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
