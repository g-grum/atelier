import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PermissionDecision } from '@atelier/shared'
import { PermissionPrompt, type PermissionChatItem } from './PermissionPrompt'

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

const alwaysButton = () => screen.getByRole('button', { name: /always/i })

describe('PermissionPrompt', () => {
  test('renders the command to run inside a <code> element', () => {
    renderPrompt()
    const command = screen.getByText('git push --force-with-lease origin main')
    expect(command.tagName).toBe('CODE')
  })

  // Semantics: the card is a labelled group (NOT an alertdialog — it is inline
  // and non-modal); the announcement duty falls to a live region inside it.
  test('the card is a labelled group and an unresolved request announces the command assertively', () => {
    renderPrompt()
    expect(screen.getByRole('group', { name: 'Permission request' })).toBeTruthy()
    // role="alert" is an assertive live region: inserting the card mid-turn is
    // announced — without it a screen-reader user hears the turn silently hang.
    expect(screen.getByRole('alert').textContent).toContain('git push --force-with-lease origin main')
  })

  test('a resolved card no longer announces itself', () => {
    renderPrompt({ resolved: 'allow' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('a resolved card states the decision taken', () => {
    renderPrompt({ resolved: 'deny' })
    expect(screen.getByText('Denied')).toBeTruthy()
    cleanup()
    renderPrompt({ resolved: 'allow' })
    expect(screen.getByText('Allowed')).toBeTruthy()
    cleanup()
    renderPrompt({ resolved: 'always' })
    expect(screen.getByText('Always allowed')).toBeTruthy()
  })

  test('no outcome line while the request is pending', () => {
    renderPrompt()
    expect(screen.queryByText(/^(Allowed|Denied|Always allowed)$/)).toBeNull()
  })

  test('deciding parks focus on the card — never dropped to <body> when the button disables', () => {
    renderPrompt()
    const button = screen.getByRole('button', { name: 'Allow once' })
    button.focus()
    fireEvent.click(button)
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Permission request' }))
  })

  // The spec's safety display: the user must see exactly what "Always" will
  // allow BEFORE clicking — never a bare "Always" that silently allows more.
  test('the Always button shows the Bash command prefix the rule will allow', () => {
    renderPrompt()
    expect(alwaysButton().textContent).toContain('git push')
  })

  test('the Always button shows the path glob for file-tool rules', () => {
    renderPrompt({
      toolName: 'Edit',
      rendered: 'Edit src/auth/refresh.ts',
      proposedRule: { toolName: 'Edit', matcher: 'src/auth/**' },
    })
    expect(alwaysButton().textContent).toContain('src/auth/**')
  })

  test('the Always button falls back to the tool name when the matcher is null', () => {
    renderPrompt({
      toolName: 'Read',
      rendered: 'Read /etc/hosts',
      proposedRule: { toolName: 'Read', matcher: null },
    })
    expect(alwaysButton().textContent).toContain('Read')
  })

  test('no Always button when no safe rule can be proposed (proposedRule null)', () => {
    renderPrompt({ proposedRule: null })
    expect(screen.queryByRole('button', { name: /always/i })).toBeNull()
    // The one-shot decisions stay available.
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
  })

  test('each button reports its decision exactly once per click', () => {
    const decisions = renderPrompt()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(decisions).toEqual(['deny'])
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(decisions).toEqual([])
  })
})
