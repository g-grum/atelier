import { describe, expect, test } from 'bun:test'
import { deriveProposedRule, ruleMatches } from './derive-matcher'

describe('deriveProposedRule', () => {
  test('Bash: first two words', () => {
    expect(deriveProposedRule('Bash', { command: 'git push --force-with-lease origin x' }))
      .toEqual({ toolName: 'Bash', matcher: 'git push' })
  })
  test('Bash single word command', () => {
    expect(deriveProposedRule('Bash', { command: 'ls' })).toEqual({ toolName: 'Bash', matcher: 'ls' })
  })
  test('Edit: project-folder glob from file_path', () => {
    expect(deriveProposedRule('Edit', { file_path: '/home/g/proj/src/a.ts' }, '/home/g/proj'))
      .toEqual({ toolName: 'Edit', matcher: '/home/g/proj/**' })
  })
  test('Write: project-folder glob like Edit', () => {
    expect(deriveProposedRule('Write', { file_path: '/home/g/proj/src/new.ts' }, '/home/g/proj'))
      .toEqual({ toolName: 'Write', matcher: '/home/g/proj/**' })
  })
  test('Read: whole tool', () => {
    expect(deriveProposedRule('Read', { file_path: '/x' })).toEqual({ toolName: 'Read', matcher: null })
  })
  test('unknown tools get NO proposed rule (UI hides "Always")', () => {
    expect(deriveProposedRule('SomeMcpTool', { anything: 1 })).toBeNull()
  })
})

describe('ruleMatches (word boundary)', () => {
  const rule = { id: 'r', projectId: 'p', toolName: 'Bash', matcher: 'git push' }
  test('matches the exact prefix and longer commands', () => {
    expect(ruleMatches(rule, 'Bash', { command: 'git push origin x' })).toBe(true)
    expect(ruleMatches(rule, 'Bash', { command: 'git push' })).toBe(true)
  })
  test('does NOT match a longer word', () => {
    expect(ruleMatches(rule, 'Bash', { command: 'git pushx' })).toBe(false)
  })
  test('glob matcher confines file tools to the folder', () => {
    const editRule = { ...rule, toolName: 'Edit', matcher: '/proj/**' }
    expect(ruleMatches(editRule, 'Edit', { file_path: '/proj/src/a.ts' })).toBe(true)
    expect(ruleMatches(editRule, 'Edit', { file_path: '/other/a.ts' })).toBe(false)
  })
})
