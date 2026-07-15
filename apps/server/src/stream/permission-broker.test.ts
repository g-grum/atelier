import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionRequest } from '@atelier/shared'
import type { SdkTurnEvent } from '../sdk/sdk-client'
import { MockSdkClient } from '../sdk/sdk-client.mock'
import { AppData } from '../store/app-data'
import { PermissionBroker } from './permission-broker'

function setup() {
  const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-broker-')), 'data.json')
  const data = new AppData(filePath)
  const events: PermissionRequest[] = []
  const broker = new PermissionBroker(data, 'p1', '/proj', (event) => events.push(event))
  return { data, events, broker }
}

describe('PermissionBroker', () => {
  test('request() returns a pending promise and emits a permission_request through the sink', () => {
    const { broker, events } = setup()

    const promise = broker.request('Bash', { command: 'git push origin main' })

    expect(promise).toBeInstanceOf(Promise)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'permission_request',
      requestId: expect.any(String),
      toolName: 'Bash',
      rendered: 'git push origin main',
      proposedRule: { toolName: 'Bash', matcher: 'git push' },
    })

    // file tools derive their glob from the broker's project folder
    broker.request('Edit', { file_path: '/proj/src/a.ts' })
    expect(events[1]?.proposedRule).toEqual({ toolName: 'Edit', matcher: '/proj/**' })
  })

  test("resolve('allow') settles allow; resolve('deny') settles deny with a message for the SDK", async () => {
    const { broker, events } = setup()
    const allowed = broker.request('Bash', { command: 'rm -rf /tmp/a' })
    const denied = broker.request('Bash', { command: 'rm -rf /tmp/b' })

    broker.resolve(events[0]!.requestId, 'allow')
    broker.resolve(events[1]!.requestId, 'deny')

    await expect(allowed).resolves.toEqual({ behavior: 'allow' })
    const result = await denied
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') expect(result.message.length).toBeGreaterThan(0)
  })

  test("resolve('always') persists the proposedRule as a per-project AlwaysRule THEN allows", async () => {
    const { broker, events, data } = setup()
    const promise = broker.request('Bash', { command: 'git push origin main' })

    broker.resolve(events[0]!.requestId, 'always')

    await expect(promise).resolves.toEqual({ behavior: 'allow' })
    expect(data.get().rules).toEqual([
      { id: expect.any(String), projectId: 'p1', toolName: 'Bash', matcher: 'git push' },
    ])
  })

  test('a stored matching rule short-circuits: allow immediately, NO event emitted', async () => {
    const { broker, events, data } = setup()
    data.update((d) => {
      d.rules.push({ id: 'r-other', projectId: 'other-project', toolName: 'Bash', matcher: 'git push' })
      d.rules.push({ id: 'r1', projectId: 'p1', toolName: 'Bash', matcher: 'git push' })
    })

    await expect(broker.request('Bash', { command: 'git push origin main' })).resolves.toEqual({ behavior: 'allow' })
    expect(events).toHaveLength(0)

    // rules are per-project: another project's rule alone must NOT short-circuit
    data.update((d) => {
      d.rules = d.rules.filter((rule) => rule.id !== 'r1')
    })
    broker.request('Bash', { command: 'git push origin main' })
    expect(events).toHaveLength(1)
  })

  test('pending() returns outstanding requests so a (re)connect can re-emit them', () => {
    const { broker, events } = setup()
    broker.request('Bash', { command: 'git push' })
    broker.request('Edit', { file_path: '/proj/src/a.ts' })

    expect(broker.pending()).toEqual(events)

    broker.resolve(events[0]!.requestId, 'allow')
    expect(broker.pending()).toEqual([events[1]!])
  })

  test('abort() settles unresolved requests as deny so an aborted query unwinds cleanly', async () => {
    const { broker, events } = setup()
    const sdk = new MockSdkClient({
      turns: [[
        { type: 'needs_permission', toolName: 'Bash', input: { command: 'rm -rf /' } },
        { type: 'turn_done' },
      ]],
    })
    const controller = new AbortController()
    const collected: SdkTurnEvent[] = []
    const consuming = (async () => {
      for await (const event of sdk.runTurn({
        cwd: '/proj',
        model: 'claude-fable-5',
        prompt: 'x',
        canUseTool: (toolName, input) => broker.request(toolName, input),
        signal: controller.signal,
      })) {
        collected.push(event)
      }
    })()
    await Bun.sleep(0) // let the turn reach the pending permission
    expect(events).toHaveLength(1)

    broker.abort()
    controller.abort()
    await consuming

    expect(broker.pending()).toEqual([])
    expect(collected).toEqual([{ type: 'tool_result', toolUseId: expect.any(String), ok: false, summary: expect.any(String) }])
  })
})
