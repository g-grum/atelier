import { describe, expect, test } from 'bun:test'
import { describeToolUse, renderForPermission, toolKindOf } from './describe-tool-use'

describe('toolKindOf', () => {
  test('known tool names map to their kind', () => {
    expect(toolKindOf('Bash')).toBe('Bash')
    expect(toolKindOf('Edit')).toBe('Edit')
    expect(toolKindOf('Write')).toBe('Write')
    expect(toolKindOf('Read')).toBe('Read')
  })
  test('unknown tool name maps to Other', () => {
    expect(toolKindOf('mcp__github__create_pr')).toBe('Other')
  })
})

describe('describeToolUse', () => {
  test('Bash: summary is the command', () => {
    expect(describeToolUse('Bash', { command: 'bun validate' }))
      .toEqual({ kind: 'Bash', summary: 'bun validate' })
  })
  test('Bash: summary truncated at 80 chars', () => {
    const command = 'echo ' + 'x'.repeat(100)
    const { summary } = describeToolUse('Bash', { command })
    expect(summary).toHaveLength(80)
    expect(summary.startsWith('echo xxx')).toBe(true)
    expect(summary.endsWith('…')).toBe(true)
  })
  test('Edit: basename summary, file, diffstat from new/old line counts', () => {
    expect(describeToolUse('Edit', { file_path: '/p/src/a.ts', old_string: 'aaa\nbb', new_string: 'c' }))
      .toEqual({ kind: 'Edit', summary: 'a.ts', file: '/p/src/a.ts', diffstat: { added: 1, removed: 2 } })
  })
  test('Write: added = content line count, removed 0', () => {
    expect(describeToolUse('Write', { file_path: '/p/src/b.ts', content: 'l1\nl2\nl3' }))
      .toEqual({ kind: 'Write', summary: 'b.ts', file: '/p/src/b.ts', diffstat: { added: 3, removed: 0 } })
  })
  test('Read: basename summary, file, line from offset', () => {
    expect(describeToolUse('Read', { file_path: '/p/src/c.ts', offset: 42 }))
      .toEqual({ kind: 'Read', summary: 'c.ts', file: '/p/src/c.ts', line: 42 })
    expect(describeToolUse('Read', { file_path: '/p/src/c.ts' }))
      .toEqual({ kind: 'Read', summary: 'c.ts', file: '/p/src/c.ts' })
  })
  test('unknown tool: kind Other, summary is the tool name', () => {
    expect(describeToolUse('mcp__github__create_pr', { title: 'x' }))
      .toEqual({ kind: 'Other', summary: 'mcp__github__create_pr' })
  })
})

describe('renderForPermission', () => {
  test('Bash: FULL command, no truncation', () => {
    const command = 'echo ' + 'x'.repeat(200)
    expect(renderForPermission('Bash', { command })).toBe(command)
  })
  test('file tools: render the path', () => {
    expect(renderForPermission('Edit', { file_path: '/p/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('/p/src/a.ts')
    expect(renderForPermission('Write', { file_path: '/p/src/b.ts', content: 'x' })).toBe('/p/src/b.ts')
    expect(renderForPermission('Read', { file_path: '/p/src/c.ts' })).toBe('/p/src/c.ts')
  })
  test('unknown tool: JSON of the input', () => {
    expect(renderForPermission('mcp__github__create_pr', { title: 'x' })).toBe('{"title":"x"}')
  })
})
