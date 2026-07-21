import type { ChatMessage } from '@atelier/shared'
import type { CanUseTool, RunTurnParams, SdkClient, SdkSessionInfo, SdkTurnEvent } from './sdk-client'

type NeedsPermission = { type: 'needs_permission'; toolName: string; input: unknown }
type ScriptedEvent = SdkTurnEvent | NeedsPermission

type MockOptions = {
  sessions?: SdkSessionInfo[]
  messages?: ChatMessage[]
  turns?: ScriptedEvent[][]
}

export class MockSdkClient implements SdkClient {
  readonly calls: { method: string; args: unknown[] }[] = []

  private readonly sessions: SdkSessionInfo[]
  private readonly messages: ChatMessage[]
  private readonly turns: ScriptedEvent[][]
  private turnIndex = 0

  constructor({ sessions = [], messages = [], turns = [] }: MockOptions = {}) {
    this.sessions = sessions
    this.messages = messages
    this.turns = turns
  }

  async listSessions(cwd: string): Promise<SdkSessionInfo[]> {
    this.calls.push({ method: 'listSessions', args: [cwd] })
    return this.sessions
  }

  async getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
    this.calls.push({ method: 'getSessionMessages', args: [sessionId] })
    return this.messages
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    this.calls.push({ method: 'renameSession', args: [sessionId, name] })
  }

  async deleteSession(sessionId: string, dir: string): Promise<void> {
    this.calls.push({ method: 'deleteSession', args: [sessionId, dir] })
  }

  async *runTurn(params: RunTurnParams): AsyncIterable<SdkTurnEvent> {
    this.calls.push({ method: 'runTurn', args: [params] })

    const turn = this.turns[this.turnIndex++] ?? []

    for (const event of turn) {
      if (params.signal.aborted) return

      if (event.type !== 'needs_permission') {
        yield event
        continue
      }

      // needs_permission marker: ask the caller and act on the decision
      const result = await params.canUseTool(event.toolName, event.input)
      if (result.behavior === 'deny') {
        const fakeId = `denied-${Math.random().toString(36).slice(2)}`
        yield { type: 'tool_result', toolUseId: fakeId, ok: false, summary: result.message }
      }
      // on allow: simply continue to the next event
    }
  }
}
