import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Composer, type ComposerProps } from './Composer'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  const sent: string[] = []
  const aborts: true[] = []
  const props: ComposerProps = {
    disabled: false,
    status: 'idle',
    onSend: (text) => {
      sent.push(text)
      return true
    },
    onAbort: () => aborts.push(true),
    ...overrides,
  }
  const view = render(<Composer {...props} />)
  const rerenderWith = (next: Partial<ComposerProps>) => view.rerender(<Composer {...props} {...next} />)
  return { sent, aborts, rerenderWith }
}

const textarea = () => screen.getByLabelText('Répondre à Claude')
const sendButton = () => screen.getByRole('button', { name: 'Envoyer le message' })
const stopButton = () => screen.getByRole('button', { name: 'Arrêter la génération' })

describe('Composer', () => {
  test('idle: clicking the send button sends the typed text and clears the draft', () => {
    const { sent } = renderComposer()
    fireEvent.change(textarea(), { target: { value: '  Bonjour Claude  ' } })
    fireEvent.click(sendButton())
    expect(sent).toEqual(['Bonjour Claude'])
    expect((textarea() as HTMLTextAreaElement).value).toBe('')
  })

  test('idle: no stop affordance', () => {
    renderComposer()
    expect(screen.queryByRole('button', { name: 'Arrêter la génération' })).toBeNull()
  })

  test('streaming: the button becomes Stop and clicking it aborts exactly once, never sends', () => {
    const { sent, aborts } = renderComposer({ status: 'streaming' })
    expect(screen.queryByRole('button', { name: 'Envoyer le message' })).toBeNull()
    fireEvent.click(stopButton())
    expect(aborts).toHaveLength(1)
    expect(sent).toEqual([])
  })

  test('streaming: Enter and ⌘↵ do not send — the draft is kept', () => {
    const { sent, aborts } = renderComposer({ status: 'streaming' })
    fireEvent.change(textarea(), { target: { value: 'Encore une chose' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true })
    expect(sent).toEqual([])
    expect(aborts).toEqual([])
    expect((textarea() as HTMLTextAreaElement).value).toBe('Encore une chose')
  })

  test('streaming: typing stays possible — the textarea is not disabled', () => {
    renderComposer({ status: 'streaming' })
    expect((textarea() as HTMLTextAreaElement).disabled).toBe(false)
  })

  test('back to idle: the button reverts to Send and the kept draft can go out', () => {
    const { sent, rerenderWith } = renderComposer({ status: 'streaming' })
    fireEvent.change(textarea(), { target: { value: 'Encore une chose' } })
    rerenderWith({ status: 'idle' })
    expect(screen.queryByRole('button', { name: 'Arrêter la génération' })).toBeNull()
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sent).toEqual(['Encore une chose'])
  })

  test('no session: both the textarea and the action button are inert', () => {
    const { sent } = renderComposer({ disabled: true })
    expect((textarea() as HTMLTextAreaElement).disabled).toBe(true)
    const button = sendButton() as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(sent).toEqual([])
  })

  test('a refused send (mid-turn race) keeps the draft', () => {
    renderComposer({ onSend: () => false })
    fireEvent.change(textarea(), { target: { value: 'Bonjour' } })
    fireEvent.click(sendButton())
    expect((textarea() as HTMLTextAreaElement).value).toBe('Bonjour')
  })
})
