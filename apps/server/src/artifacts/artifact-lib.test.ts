import { describe, expect, test } from 'bun:test'
import { extractImagePaths, normalizeToProject } from './artifact-lib'

describe('extractImagePaths', () => {
  test('Write with an image file_path yields that path', () => {
    expect(extractImagePaths('Write', { file_path: '/proj/shots/home.png', content: '…' })).toEqual(['/proj/shots/home.png'])
  })

  test('Edit with an image file_path yields that path', () => {
    expect(extractImagePaths('Edit', { file_path: 'assets/logo.svg', old_string: 'a', new_string: 'b' })).toEqual(['assets/logo.svg'])
  })

  test('Write with a non-image file_path yields nothing', () => {
    expect(extractImagePaths('Write', { file_path: '/proj/src/index.ts' })).toEqual([])
  })

  test('every supported extension is recognized, case-insensitively', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'PNG', 'JPEG']) {
      expect(extractImagePaths('Write', { file_path: `x.${ext}` })).toEqual([`x.${ext}`])
    }
  })

  test('Bash command: collects tokens ending in image extensions', () => {
    expect(extractImagePaths('Bash', { command: 'screencapture -x shots/out.png && open shots/out.png' }))
      .toEqual(['shots/out.png'])
  })

  test('Bash command: strips surrounding quotes and trailing punctuation', () => {
    expect(extractImagePaths('Bash', { command: `cp "a b.png" 'dest/final.webp';` }))
      .toEqual(['a b.png', 'dest/final.webp'])
  })

  test('Bash command without image tokens yields nothing', () => {
    expect(extractImagePaths('Bash', { command: 'bun test && git status' })).toEqual([])
  })

  test('unknown tools and malformed inputs yield nothing', () => {
    expect(extractImagePaths('Read', { file_path: 'x.png' })).toEqual([])
    expect(extractImagePaths('Bash', { command: 42 })).toEqual([])
    expect(extractImagePaths('Write', null)).toEqual([])
  })
})

describe('normalizeToProject', () => {
  test('absolute path under the root becomes root-relative', () => {
    expect(normalizeToProject('/proj', '/proj/shots/home.png')).toBe('shots/home.png')
  })

  test('relative path resolves against the root', () => {
    expect(normalizeToProject('/proj', 'shots/home.png')).toBe('shots/home.png')
  })

  test('traversal escaping the root is rejected', () => {
    expect(normalizeToProject('/proj', '../etc/passwd.png')).toBeNull()
    expect(normalizeToProject('/proj', '/proj/../etc/x.png')).toBeNull()
    expect(normalizeToProject('/proj', '/elsewhere/x.png')).toBeNull()
  })

  test('inner .. that stays inside the root is normalized, not rejected', () => {
    expect(normalizeToProject('/proj', 'shots/../shots/a.png')).toBe('shots/a.png')
  })

  test('the root itself and NUL bytes are rejected', () => {
    expect(normalizeToProject('/proj', '/proj')).toBeNull()
    expect(normalizeToProject('/proj', 'a\0.png')).toBeNull()
  })

  test('sibling directory sharing the root prefix is rejected (no startsWith footgun)', () => {
    expect(normalizeToProject('/proj', '/project-evil/x.png')).toBeNull()
  })
})
