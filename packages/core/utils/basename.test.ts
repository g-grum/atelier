import { expect, test } from 'bun:test'
import { basename } from './basename'

test('returns the last segment of a path', () => {
  expect(basename('/Users/me/workspace/atelier')).toBe('atelier')
})

test('ignores a trailing slash', () => {
  expect(basename('/Users/me/atelier/')).toBe('atelier')
})

test('falls back to the input when there is no segment', () => {
  expect(basename('/')).toBe('/')
  expect(basename('')).toBe('')
})
