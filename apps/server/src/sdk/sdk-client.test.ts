import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveMessageCount, encodeProjectDir } from './sdk-client'

describe('encodeProjectDir', () => {
  // The CLI's real scheme (verified against the SDK bundle — replace(/[^a-zA-Z0-9]/g,"-")
  // — and against the actual ~/.claude/projects entries): EVERY non-alphanumeric
  // character becomes '-', and the leading dash is KEPT. The old encoding stripped
  // the leading dash, so every lookup missed and messageCount was always 0.
  test('keeps the leading dash: /Users/…/atelier → -Users-…-atelier', () => {
    expect(encodeProjectDir('/Users/demo/workspace/atelier')).toBe('-Users-demo-workspace-atelier')
  })

  test('encodes dots as dashes (real worktree entry observed on disk)', () => {
    expect(encodeProjectDir('/Users/demo/workspace/demoapp-frontend/.claude/worktrees/agile-soaring-sifakis')).toBe(
      '-Users-demo-workspace-demoapp-frontend--claude-worktrees-agile-soaring-sifakis',
    )
  })

  test('encodes underscores and any other non-alphanumeric as dashes', () => {
    expect(encodeProjectDir('/tmp/my_app.v2')).toBe('-tmp-my-app-v2')
  })
})

describe('deriveMessageCount', () => {
  test('counts the non-empty JSONL lines of the session file', () => {
    const root = mkdtempSync(join(tmpdir(), 'atelier-projects-'))
    const cwd = '/proj/demo.app'
    mkdirSync(join(root, encodeProjectDir(cwd)), { recursive: true })
    writeFileSync(
      join(root, encodeProjectDir(cwd), 'ses-1.jsonl'),
      '{"type":"user"}\n{"type":"assistant"}\n{"type":"result"}\n',
    )
    expect(deriveMessageCount('ses-1', cwd, root)).toBe(3)
  })

  test('never throws: a missing session file yields 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'atelier-projects-'))
    expect(deriveMessageCount('nope', '/no/such/cwd', root)).toBe(0)
  })
})
