import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildQueryOptions, deriveMessageCount, encodeProjectDir, type RunTurnParams } from './sdk-client'

function makeRunTurnParams(overrides: Partial<RunTurnParams> = {}): RunTurnParams {
  return {
    cwd: '/proj',
    model: 'claude-fable-5',
    prompt: 'go',
    resumeSessionId: 'ses-1',
    canUseTool: async () => ({ behavior: 'allow' }),
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** The SDK CanUseTool callback's third argument — toolUseID is required by the signature. */
const sdkCanUseToolOptions = { signal: new AbortController().signal, toolUseID: 'tu-1' }

describe('buildQueryOptions', () => {
  test('passes includePartialMessages: true — without it the SDK emits no stream_event, so the client gets zero deltas', () => {
    const options = buildQueryOptions(makeRunTurnParams(), new AbortController())
    expect(options.includePartialMessages).toBe(true)
  })

  test('maps cwd, model, resume and the abortController through', () => {
    const abortController = new AbortController()
    const options = buildQueryOptions(makeRunTurnParams(), abortController)
    expect(options.cwd).toBe('/proj')
    expect(options.model).toBe('claude-fable-5')
    expect(options.resume).toBe('ses-1')
    expect(options.abortController).toBe(abortController)
  })

  test('allow responses echo the original input as updatedInput — the bundled CLI Zod-REQUIRES it, a bare allow fails the whole permission request', async () => {
    const seen: { toolName: string; input: unknown }[] = []
    const params = makeRunTurnParams({
      canUseTool: async (toolName, input) => {
        seen.push({ toolName, input })
        return { behavior: 'allow' }
      },
    })
    const options = buildQueryOptions(params, new AbortController())
    const input = { command: 'git push origin main' }

    const result = await options.canUseTool!('Bash', input, sdkCanUseToolOptions)

    expect(result).toEqual({ behavior: 'allow', updatedInput: input })
    expect(seen).toEqual([{ toolName: 'Bash', input }])
  })

  test('deny responses keep { behavior, message }', async () => {
    const params = makeRunTurnParams({
      canUseTool: async () => ({ behavior: 'deny', message: 'refusé par la règle' }),
    })
    const options = buildQueryOptions(params, new AbortController())

    const result = await options.canUseTool!('Bash', { command: 'rm -rf /' }, sdkCanUseToolOptions)

    expect(result).toEqual({ behavior: 'deny', message: 'refusé par la règle' })
  })
})

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
