import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolCallItem, type ToolChatItem } from './ToolCallItem'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const item: ToolChatItem = {
  kind: 'tool',
  toolUseId: 't1',
  tool: 'Edit',
  summary: 'src/auth/refresh.ts',
  file: 'src/auth/refresh.ts',
  line: 42,
  diffstat: { added: 12, removed: 3 },
  result: { ok: true, summary: 'diff appliqué' },
}

function renderItem() {
  const calls: [string, number | undefined][] = []
  render(<ToolCallItem item={item} onOpenInIde={(file, line) => calls.push([file, line])} />)
  return calls
}

describe('ToolCallItem', () => {
  test('the IDE affordance is a native button, not nested inside another interactive element', () => {
    renderItem()
    const ide = screen.getByRole('button', { name: /open in the ide/i })
    // Conforming HTML: a real <button>, with no interactive ancestor (buttons
    // must not contain interactive or tabindex-bearing descendants).
    expect(ide.tagName).toBe('BUTTON')
    expect(ide.parentElement?.closest('button, [role="button"], [tabindex]')).toBeNull()
  })

  test('clicking the IDE button opens the file at its line without toggling the detail', () => {
    const calls = renderItem()
    fireEvent.click(screen.getByRole('button', { name: /open in the ide/i }))
    expect(calls).toEqual([['src/auth/refresh.ts', 42]])
    expect(screen.queryByText('diff appliqué')).toBeNull()
  })

  test('the row toggle expands and collapses the detail', () => {
    const calls = renderItem()
    const toggle = screen.getByRole('button', { name: /src\/auth\/refresh/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('diff appliqué')).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryByText('diff appliqué')).toBeNull()
    expect(calls).toEqual([]) // toggling never opens the IDE
  })
})
