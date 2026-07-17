import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildQueryOptions, deriveMessageCount, encodeProjectDir, mapRateLimitInfo, mapSessionMessages, type RunTurnParams } from './sdk-client'

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

  test('bypassPermissions: true maps to permissionMode bypassPermissions + allowDangerouslySkipPermissions (SDK safety flag is REQUIRED)', () => {
    const options = buildQueryOptions(makeRunTurnParams({ bypassPermissions: true }), new AbortController())
    expect(options.permissionMode).toBe('bypassPermissions')
    expect(options.allowDangerouslySkipPermissions).toBe(true)
  })

  test('without bypassPermissions the options carry neither permissionMode nor the dangerous flag', () => {
    const options = buildQueryOptions(makeRunTurnParams(), new AbortController())
    expect(options.permissionMode).toBeUndefined()
    expect(options.allowDangerouslySkipPermissions).toBeUndefined()
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

describe('mapRateLimitInfo', () => {
  test('maps a full info: fraction → percent (floored like the CLI), epoch-ms resetsAt → ISO', () => {
    expect(mapRateLimitInfo({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.347, resetsAt: 1784736000000 })).toEqual({
      type: 'rate_limit',
      window: 'five_hour',
      utilization: 34,
      status: 'allowed',
      resetsAt: new Date(1784736000000).toISOString(),
    })
  })

  test('an epoch-SECONDS resetsAt is promoted to ms (guard: anything below 1e12 cannot be ms in this century)', () => {
    const event = mapRateLimitInfo({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 1784736000 })
    expect(event?.resetsAt).toBe(new Date(1784736000000).toISOString())
  })

  test('missing rateLimitType or utilization yields null — nothing to display honestly', () => {
    expect(mapRateLimitInfo({ status: 'allowed', utilization: 0.5 })).toBeNull()
    expect(mapRateLimitInfo({ status: 'allowed', rateLimitType: 'five_hour' })).toBeNull()
  })

  test('utilization is clamped to 0–100', () => {
    expect(mapRateLimitInfo({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1.2 })?.utilization).toBe(100)
    expect(mapRateLimitInfo({ status: 'allowed', rateLimitType: 'five_hour', utilization: -0.1 })?.utilization).toBe(0)
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

describe('mapSessionMessages', () => {
  const sessionMessage = (type: 'user' | 'assistant', content: unknown): SessionMessage => ({
    type,
    uuid: 'uuid-1',
    session_id: 'ses-1',
    message: { role: type, content },
    parent_tool_use_id: null,
  })

  test('user prompt persisted as a plain string keeps its text (pre-2.x CLI transcript format)', () => {
    const out = mapSessionMessages([sessionMessage('user', 'hello atelier')])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: 'user', text: 'hello atelier' })
  })

  test('user prompt persisted as content blocks keeps its text — the CLI ≥2.x transcripts record prompts as [{type:"text",…}], observed live in ~/.claude/projects', () => {
    const out = mapSessionMessages([sessionMessage('user', [{ type: 'text', text: 'hello atelier' }])])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: 'user', text: 'hello atelier' })
  })

  test('multiple text blocks in one user message join into one bubble', () => {
    const out = mapSessionMessages([
      sessionMessage('user', [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: 'user', text: 'first\n\nsecond' })
  })

  test('tool_result-only user lines yield NO chat item — they are the model-side echo of tool results, not something the user typed', () => {
    const out = mapSessionMessages([
      sessionMessage('user', [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }]),
    ])
    expect(out).toHaveLength(0)
  })

  test('assistant text and tool_use blocks keep their mapping', () => {
    const out = mapSessionMessages([
      sessionMessage('assistant', [
        { type: 'text', text: 'here is the plan' },
        { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/proj/a.ts' } },
      ]),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ role: 'assistant', text: 'here is the plan' })
    expect(out[1]).toMatchObject({ role: 'tool', toolUseId: 'tu-1' })
  })
})
