import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatItem } from '../state/stream-reducer'
import { ChatView } from './ChatView'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

function makeItems(count: number): ChatItem[] {
  return Array.from({ length: count }, (_, index) => ({ kind: 'user', text: `message ${index}` }))
}

/**
 * happy-dom does no layout, so scroll geometry is stubbed: a 1000px-tall
 * document in a 400px viewport, with a controllable scrollTop.
 */
function setup(initialItems: ChatItem[]) {
  const view = render(
    <ChatView items={initialItems} status="idle" onOpenInIde={() => {}} onPermissionDecision={() => {}} onQuestionAnswer={() => {}} />,
  )
  const el = view.container.querySelector('.messages')
  if (!(el instanceof HTMLElement)) throw new Error('no .messages scroller')

  let scrollTop = 0
  const geometry = { scrollHeight: 1000, clientHeight: 400 }
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value
    },
  })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geometry.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geometry.clientHeight })

  const rerender = (items: ChatItem[]) =>
    view.rerender(
      <ChatView items={items} status="streaming" onOpenInIde={() => {}} onPermissionDecision={() => {}} onQuestionAnswer={() => {}} />,
    )
  const userScrollTo = (top: number) => {
    scrollTop = top
    fireEvent.scroll(el)
  }
  return { el, geometry, rerender, userScrollTo }
}

describe('ChatView auto-scroll', () => {
  test('follows the stream while the user is pinned to the bottom', () => {
    const { el, rerender } = setup(makeItems(2))
    rerender(makeItems(3))
    expect(el.scrollTop).toBe(1000)
  })

  test('stops yanking once the user scrolls up to read, for the whole turn', () => {
    const { el, rerender, userScrollTo } = setup(makeItems(2))
    userScrollTo(100) // reading an earlier message
    rerender(makeItems(3)) // a delta arrives
    expect(el.scrollTop).toBe(100)
    rerender(makeItems(4)) // and another — still not yanked
    expect(el.scrollTop).toBe(100)
  })

  test('re-pins when the user comes back near the bottom', () => {
    const { el, rerender, userScrollTo } = setup(makeItems(2))
    userScrollTo(100)
    rerender(makeItems(3))
    expect(el.scrollTop).toBe(100)
    userScrollTo(590) // 10px from the bottom — close enough
    rerender(makeItems(4))
    expect(el.scrollTop).toBe(1000)
  })

  test('re-arms the pin when content no longer overflows (fresh/empty session)', () => {
    const { el, geometry, rerender, userScrollTo } = setup(makeItems(2))
    userScrollTo(100) // unpinned in the old session
    geometry.scrollHeight = 300 // switching sessions: view emptied, nothing to scroll
    rerender([])
    geometry.scrollHeight = 1000 // history of the new session lands
    rerender(makeItems(5))
    expect(el.scrollTop).toBe(1000)
  })
})

describe('ChatView permissions', () => {
  test('a permission item renders the interactive prompt, wired with its requestId', () => {
    const calls: [string, string][] = []
    render(
      <ChatView
        items={[
          {
            kind: 'permission',
            requestId: 'req-1',
            toolName: 'Bash',
            rendered: 'git push origin main',
            proposedRule: { toolName: 'Bash', matcher: 'git push' },
          },
        ]}
        status="streaming"
        onOpenInIde={() => {}}
        onPermissionDecision={(requestId, decision) => calls.push([requestId, decision])}
        onQuestionAnswer={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Autoriser une fois' }))
    expect(calls).toEqual([['req-1', 'allow']])
  })
})

describe('ChatView questions (QCM)', () => {
  const questionItem: ChatItem = {
    kind: 'question',
    requestId: 'q1',
    questions: [
      {
        question: 'Quelle approche ?',
        header: 'Approche',
        options: [
          { label: 'A', description: 'la première' },
          { label: 'B', description: 'la seconde' },
        ],
        multiSelect: false,
      },
    ],
  }

  test('rend une carte question et remonte la réponse', () => {
    const calls: [string, Record<string, string>][] = []
    render(
      <ChatView
        items={[questionItem]}
        status="streaming"
        onOpenInIde={() => {}}
        onPermissionDecision={() => {}}
        onQuestionAnswer={(requestId, answers) => calls.push([requestId, answers])}
      />,
    )
    // Mono-question single-select : cliquer une option prédéfinie envoie directement.
    fireEvent.click(screen.getByRole('button', { name: 'A la première' }))
    expect(calls).toEqual([['q1', { 'Quelle approche ?': 'A' }]])
  })

  test('un QCM pendant masque le typing indicator', () => {
    render(
      <ChatView
        items={[questionItem]}
        status="streaming"
        onOpenInIde={() => {}}
        onPermissionDecision={() => {}}
        onQuestionAnswer={() => {}}
      />,
    )
    // Question non résolue : le tour est bloqué en attendant l'utilisateur.
    expect(screen.queryByLabelText('Claude écrit')).toBeNull()
  })
})

describe('ChatView queued messages', () => {
  test('a queued user message is marked « En attente » until it actually goes out', () => {
    const { rerender } = render(
      <ChatView
        items={[{ kind: 'user', text: 'à envoyer plus tard', queued: true }]}
        status="streaming"
        onOpenInIde={() => {}}
        onPermissionDecision={() => {}}
        onQuestionAnswer={() => {}}
      />,
    )
    expect(screen.getByText('En attente')).toBeTruthy()

    rerender(
      <ChatView
        items={[{ kind: 'user', text: 'à envoyer plus tard' }]}
        status="streaming"
        onOpenInIde={() => {}}
        onPermissionDecision={() => {}}
        onQuestionAnswer={() => {}}
      />,
    )
    expect(screen.queryByText('En attente')).toBeNull()
  })
})
