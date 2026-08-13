import { describe, expect, test } from 'bun:test'
import { extensionForMime, MAX_IMAGE_BYTES } from './image-uploads'

describe('extensionForMime', () => {
  test('png/jpeg/gif/webp', () => {
    expect(extensionForMime('image/png')).toBe('png')
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('image/gif')).toBe('gif')
    expect(extensionForMime('image/webp')).toBe('webp')
  })
  test('non supporté → null', () => {
    expect(extensionForMime('image/svg+xml')).toBeNull()
    expect(extensionForMime('application/pdf')).toBeNull()
    expect(extensionForMime('')).toBeNull()
  })
})

test('MAX_IMAGE_BYTES = 10 Mo', () => {
  expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024)
})
