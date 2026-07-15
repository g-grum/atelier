import { randomUUID } from 'node:crypto'
import type { ClientMessage, PermissionRequest } from '@atelier/shared'
import type { CanUseTool } from '../sdk/sdk-client'
import type { AppData } from '../store/app-data'
import { renderForPermission } from './describe-tool-use'
import { deriveProposedRule, ruleMatches } from './derive-matcher'

type PermissionResult = Awaited<ReturnType<CanUseTool>>
export type PermissionDecision = Extract<ClientMessage, { type: 'permission_response' }>['decision']

type Pending = {
  request: PermissionRequest
  settle: (result: PermissionResult) => void
}

/**
 * Bridges the SDK's canUseTool callback and the client's permission_response.
 * No timeout — an unanswered request stays pending until resolve() or abort().
 */
export class PermissionBroker {
  private readonly requests = new Map<string, Pending>()

  constructor(
    private readonly data: AppData,
    private readonly projectId: string,
    /** File-tool globs in proposed rules default to this folder. */
    private readonly projectDir: string,
    private readonly sink: (event: PermissionRequest) => void
  ) {}

  /** Signature-compatible with CanUseTool — hand `(t, i) => broker.request(t, i)` to the SDK. */
  request(toolName: string, input: unknown): Promise<PermissionResult> {
    const record = asRecord(input)
    const stored = this.data
      .get()
      .rules.some((rule) => rule.projectId === this.projectId && ruleMatches(rule, toolName, record))
    // A stored rule auto-allows silently — no permission_request is published.
    if (stored) return Promise.resolve({ behavior: 'allow' })

    const request: PermissionRequest = {
      type: 'permission_request',
      requestId: randomUUID(),
      toolName,
      rendered: renderForPermission(toolName, input),
      proposedRule: deriveProposedRule(toolName, record, this.projectDir),
    }
    const promise = new Promise<PermissionResult>((settle) => {
      this.requests.set(request.requestId, { request, settle })
    })
    this.sink(request)
    return promise
  }

  resolve(requestId: string, decision: PermissionDecision): void {
    const pending = this.requests.get(requestId)
    if (!pending) return

    switch (decision) {
      case 'deny':
        this.requests.delete(requestId)
        pending.settle({ behavior: 'deny', message: 'User denied this tool use' })
        return
      case 'always': {
        const rule = pending.request.proposedRule
        if (rule !== null) {
          this.data.update((d) => {
            d.rules.push({ id: randomUUID(), projectId: this.projectId, ...rule })
          })
        }
        this.requests.delete(requestId)
        pending.settle({ behavior: 'allow' })
        return
      }
      case 'allow':
        this.requests.delete(requestId)
        pending.settle({ behavior: 'allow' })
        return
      default:
        // Fail closed: typing does not survive the wire (parseClientMessage checks only
        // `type`), so an unrecognized decision must never grant permission. No-op — the
        // request stays pending and answerable.
        return
    }
  }

  /** Outstanding requests, oldest first — re-emitted on (re)connect. */
  pending(): PermissionRequest[] {
    return [...this.requests.values()].map((entry) => entry.request)
  }

  /** Settles every outstanding request as deny so the aborted query unwinds cleanly. */
  abort(): void {
    for (const entry of this.requests.values()) {
      entry.settle({ behavior: 'deny', message: 'Session aborted' })
    }
    this.requests.clear()
  }
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
}
