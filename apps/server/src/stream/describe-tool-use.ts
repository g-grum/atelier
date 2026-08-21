import { basename } from 'node:path'
import { type ToolKind, ToolKinds } from '@atelier/shared'

const SUMMARY_MAX = 80

export type ToolUseDescription = {
  kind: ToolKind
  summary: string
  file?: string
  line?: number
  diffstat?: { added: number; removed: number }
}

export function toolKindOf(toolName: string): ToolKind {
  return Object.hasOwn(ToolKinds, toolName) ? (toolName as ToolKind) : ToolKinds.Other
}

/** The single place that turns raw { toolName, input } into what the UI shows (chat items + tool_use events). */
export function describeToolUse(toolName: string, input: unknown): ToolUseDescription {
  const kind = toolKindOf(toolName)
  const record = asRecord(input)

  if (kind === 'Bash') {
    return { kind, summary: truncate(str(record.command)) }
  }

  if (kind === 'Edit' || kind === 'Write' || kind === 'Read') {
    const file = str(record.file_path)
    const description: ToolUseDescription = { kind, summary: basename(file), file }
    if (kind === 'Edit') description.diffstat = { added: lineCount(str(record.new_string)), removed: lineCount(str(record.old_string)) }
    if (kind === 'Write') description.diffstat = { added: lineCount(str(record.content)), removed: 0 }
    if (kind === 'Read' && typeof record.offset === 'number') description.line = record.offset
    return description
  }

  if (toolName === 'ExitPlanMode') {
    return { kind: ToolKinds.Other, summary: 'Plan proposed' }
  }

  if (toolName === 'AskUserQuestion') {
    // Résumé historique du QCM (mapSessionMessages) : une ligne sobre avec les headers.
    const questions = Array.isArray(record.questions) ? record.questions : []
    const headers = questions.map((q) => str(asRecord(q).header)).filter((h) => h !== '')
    return { kind: ToolKinds.Other, summary: truncate(headers.length > 0 ? `QCM : ${headers.join(', ')}` : 'QCM') }
  }

  return { kind: ToolKinds.Other, summary: toolName }
}

/** Full, untruncated rendering for permission prompts — the user must see exactly what runs. */
export function renderForPermission(toolName: string, input: unknown): string {
  const kind = toolKindOf(toolName)
  const record = asRecord(input)
  if (kind === 'Bash' && typeof record.command === 'string') return record.command
  if ((kind === 'Edit' || kind === 'Write' || kind === 'Read') && typeof record.file_path === 'string') return record.file_path
  // ExitPlanMode: the plan markdown IS the thing being approved — show it whole.
  if (toolName === 'ExitPlanMode' && typeof record.plan === 'string') return record.plan
  // Malformed/unknown input: render the whole thing rather than '' — an empty
  // permission prompt that still executes the real input on approval is fail-open.
  const json: string | undefined = JSON.stringify(input)
  return json ?? String(input)
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function truncate(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}
