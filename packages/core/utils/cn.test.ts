import { expect, test } from 'bun:test'
import { cn } from './cn'

test('joins class names', () => {
  expect(cn('flex', 'items-center')).toBe('flex items-center')
})

test('drops falsy values', () => {
  expect(cn('flex', false && 'hidden', undefined)).toBe('flex')
})

test('lets the later conflicting Tailwind utility win', () => {
  expect(cn('p-2', 'p-4')).toBe('p-4')
})
