import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PermissionPrompt, type PermissionChatItem, type PermissionDecision } from './PermissionPrompt'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

function makeItem(overrides: Partial<PermissionChatItem> = {}): PermissionChatItem {
  return {
    kind: 'permission',
    requestId: 'req-1',
    toolName: 'Bash',
    rendered: 'git push --force-with-lease origin main',
    proposedRule: { toolName: 'Bash', matcher: 'git push' },
    ...overrides,
  }
}

function renderPrompt(overrides: Partial<PermissionChatItem> = {}) {
  const decisions: PermissionDecision[] = []
  render(<PermissionPrompt item={makeItem(overrides)} onDecision={(decision) => decisions.push(decision)} />)
  return decisions
}

const alwaysButton = () => screen.getByRole('button', { name: /toujours/i })

describe('PermissionPrompt', () => {
  test('renders the command to run inside a <code> element', () => {
    renderPrompt()
    const command = screen.getByText('git push --force-with-lease origin main')
    expect(command.tagName).toBe('CODE')
  })

  // The spec's safety display: the user must see exactly what "Always" will
  // allow BEFORE clicking — never a bare "Toujours" that silently allows more.
  test('the Toujours button shows the Bash command prefix the rule will allow', () => {
    renderPrompt()
    expect(alwaysButton().textContent).toContain('git push')
  })

  test('the Toujours button shows the path glob for file-tool rules', () => {
    renderPrompt({
      toolName: 'Edit',
      rendered: 'Edit src/auth/refresh.ts',
      proposedRule: { toolName: 'Edit', matcher: 'src/auth/**' },
    })
    expect(alwaysButton().textContent).toContain('src/auth/**')
  })

  test('the Toujours button falls back to the tool name when the matcher is null', () => {
    renderPrompt({
      toolName: 'Read',
      rendered: 'Read /etc/hosts',
      proposedRule: { toolName: 'Read', matcher: null },
    })
    expect(alwaysButton().textContent).toContain('Read')
  })

  test('no Toujours button when no safe rule can be proposed (proposedRule null)', () => {
    renderPrompt({ proposedRule: null })
    expect(screen.queryByRole('button', { name: /toujours/i })).toBeNull()
    // The one-shot decisions stay available.
    expect(screen.getByRole('button', { name: 'Refuser' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Autoriser une fois' })).toBeTruthy()
  })

  test('each button reports its decision exactly once per click', () => {
    const decisions = renderPrompt()
    fireEvent.click(screen.getByRole('button', { name: 'Refuser' }))
    expect(decisions).toEqual(['deny'])
    fireEvent.click(screen.getByRole('button', { name: 'Autoriser une fois' }))
    expect(decisions).toEqual(['deny', 'allow'])
    fireEvent.click(alwaysButton())
    expect(decisions).toEqual(['deny', 'allow', 'always'])
  })

  test('all actions are disabled once the request is resolved', () => {
    const decisions = renderPrompt({ resolved: 'allow' })
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Refuser' }))
    expect(decisions).toEqual([])
  })
})
