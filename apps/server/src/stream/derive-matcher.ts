import type { AlwaysRule, ProposedRule } from '@atelier/shared'

type ToolInput = Record<string, unknown>

export function deriveProposedRule(toolName: string, input: ToolInput, projectDir?: string): ProposedRule | null {
  if (toolName === 'Bash') {
    const command = String(input.command ?? '')
    const words = command.trim().split(/\s+/)
    const matcher = words.length >= 2 ? `${words[0]} ${words[1]}` : words[0]
    return { toolName, matcher: matcher ?? command }
  }

  if (toolName === 'Edit' || toolName === 'Write') {
    const matcher = projectDir != null ? `${projectDir}/**` : null
    return { toolName, matcher }
  }

  if (toolName === 'Read') {
    return { toolName, matcher: null }
  }

  // Unknown/sensitive tools: no "Always" button
  return null
}

export function ruleMatches(rule: AlwaysRule, toolName: string, input: ToolInput): boolean {
  if (rule.toolName !== toolName) return false

  if (rule.matcher === null) return true

  if (toolName === 'Bash') {
    const command = String(input.command ?? '')
    const m = rule.matcher
    // Word-boundary prefix: command must equal matcher or matcher must be followed by whitespace
    return command === m || command.startsWith(`${m} `)
  }

  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') {
    const filePath = String(input.file_path ?? '')
    return new Bun.Glob(rule.matcher).match(filePath)
  }

  return false
}
