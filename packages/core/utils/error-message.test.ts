import { expect, test } from 'bun:test'
import { errorMessage } from './error-message'

test('uses the message of an Error', () => {
  expect(errorMessage(new Error('session not found'))).toBe('session not found')
})

test('stringifies a non-Error value', () => {
  expect(errorMessage('boom')).toBe('boom')
  expect(errorMessage(42)).toBe('42')
})

test('stringifies an Error with an empty message', () => {
  expect(errorMessage(new Error(''))).toBe('Error')
})
