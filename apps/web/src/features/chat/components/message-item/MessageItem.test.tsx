import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MessageItem } from '@/features/chat/components/message-item/MessageItem'

// RTL enveloppe rendus/événements dans act() — React 19 exige le flag hors preset de runner.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

describe('MessageItem markdown', () => {
  // Le pipeline markdown est chargé paresseusement (React.lazy) — les assertions
  // sur le rendu markdown attendent donc la résolution du chunk (findBy*/waitFor).
  // Le fallback texte brut du Suspense n'est pas testable de façon fiable ici :
  // une fois le module lazy résolu (par n'importe quel test de la suite), les
  // rendus suivants ne suspendent plus.
  test('assistant : gras, titre et liste rendus en éléments HTML', async () => {
    render(<MessageItem role="assistant" text={'# Titre\n\nDu **gras**\n\n- un item'} />)
    expect(await screen.findByRole('heading', { name: 'Titre' })).toBeTruthy()
    expect(screen.getByText('gras').tagName).toBe('STRONG')
    expect(screen.getByRole('listitem').textContent).toBe('un item')
  })

  test('user : texte brut, la syntaxe markdown reste littérale', () => {
    render(<MessageItem role="user" text={'Du **gras** ici'} />)
    expect(screen.getByText('Du **gras** ici')).toBeTruthy()
    expect(document.querySelector('strong')).toBeNull()
  })

  test('assistant : bloc de code fencé → <code class="language-ts">', async () => {
    render(<MessageItem role="assistant" text={'```ts\nconst a = 1\n```'} />)
    await waitFor(() => {
      const code = document.querySelector('pre code')
      expect(code?.className).toContain('language-ts')
      expect(code?.textContent).toContain('const')
    })
  })

  test('Copy button: writes the code to the clipboard and shows Copied', async () => {
    const writeText = mock(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<MessageItem role="assistant" text={'```ts\nconst a = 1\n```'} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('const a = 1\n')
    expect(await screen.findByText('Copied')).toBeTruthy()
  })
})

describe('MessageItem user collapse (sticky prompts, spec 2026-08-21)', () => {
  // happy-dom has no layout: scrollHeight is 0, so the overflow measurement is
  // faked by redefining scrollHeight on the live node, then re-running the
  // effect via a text change (same deps as the component's useLayoutEffect).
  function renderOverflowing() {
    const view = render(<MessageItem role="user" text="first" />)
    const body = document.querySelector('.msg.user .body') as HTMLDivElement
    Object.defineProperty(body, 'scrollHeight', { value: 400, configurable: true })
    view.rerender(<MessageItem role="user" text="a much longer prompt" />)
    return body
  }

  test('a short message is not collapsible — no button semantics, no cap', () => {
    render(<MessageItem role="user" text="short" />)
    const body = document.querySelector('.msg.user .body') as HTMLDivElement
    expect(body.className).toBe('body')
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('an overflowing message collapses; click expands and collapses again', () => {
    const body = renderOverflowing()

    expect(body.className).toContain('collapsed')
    const toggle = screen.getByRole('button', { name: 'Expand message' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(body.className).toContain('expanded')
    expect(body.className).not.toContain('collapsed')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(body.className).toContain('collapsed')
  })

  test('keyboard toggles too (Enter and Space)', () => {
    const body = renderOverflowing()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Expand message' }), { key: 'Enter' })
    expect(body.className).toContain('expanded')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Collapse message' }), { key: ' ' })
    expect(body.className).toContain('collapsed')
  })
})
