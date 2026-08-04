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
    commands: [],
    ...overrides,
  }
  const view = render(<Composer {...props} />)
  const rerenderWith = (next: Partial<ComposerProps>) => view.rerender(<Composer {...props} {...next} />)
  return { sent, aborts, rerenderWith }
}

const textarea = () => screen.getByLabelText('Répondre à Claude')
const sendButton = () => screen.getByRole('button', { name: 'Envoyer le message' })
const stopButton = () => screen.getByRole('button', { name: 'Arrêter la génération' })

const CMDS = [
  { name: 'review', description: 'Relire', argumentHint: '<file>', aliases: [] },
  { name: 'superpowers:brainstorming', description: 'Brainstorm', argumentHint: '', aliases: ['brainstorming'] },
]

/** Frappe en positionnant le curseur en fin de texte (le déclenchement dépend du caret). */
function type(value: string) {
  const el = textarea() as HTMLTextAreaElement
  fireEvent.change(el, { target: { value, selectionStart: value.length } })
}

const options = () => screen.queryAllByRole('option')

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

  test('streaming: Enter posts the message anyway (queued by the controller) and clears the draft', () => {
    const { sent, aborts } = renderComposer({ status: 'streaming' })
    fireEvent.change(textarea(), { target: { value: 'Encore une chose' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sent).toEqual(['Encore une chose'])
    expect(aborts).toEqual([])
    expect((textarea() as HTMLTextAreaElement).value).toBe('')

    fireEvent.change(textarea(), { target: { value: 'Et puis ça' } })
    fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true })
    expect(sent).toEqual(['Encore une chose', 'Et puis ça'])
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

  test('session becomes active: the textarea grabs focus so typing can start immediately', () => {
    const { rerenderWith } = renderComposer({ disabled: true })
    expect(document.activeElement).not.toBe(textarea())
    rerenderWith({ disabled: false })
    expect(document.activeElement).toBe(textarea())
  })

  test('mounted already active (fresh session): the textarea has focus', () => {
    renderComposer({ disabled: false })
    expect(document.activeElement).toBe(textarea())
  })

  test('a refused send (no socket / resync) keeps the draft', () => {
    renderComposer({ onSend: () => false })
    fireEvent.change(textarea(), { target: { value: 'Bonjour' } })
    fireEvent.click(sendButton())
    expect((textarea() as HTMLTextAreaElement).value).toBe('Bonjour')
  })

  test('the textarea grows with its content and is capped — multi-line drafts stay readable', () => {
    renderComposer()
    const el = textarea() as HTMLTextAreaElement
    // happy-dom has no layout — stub the measurement the resize reads.
    Object.defineProperty(el, 'scrollHeight', { value: 120, configurable: true })
    fireEvent.change(el, { target: { value: 'ligne 1\nligne 2\nligne 3\nligne 4' } })
    expect(el.style.height).toBe('120px')

    Object.defineProperty(el, 'scrollHeight', { value: 999, configurable: true })
    fireEvent.change(el, { target: { value: 'beaucoup\nde\nlignes\n'.repeat(20) } })
    expect(el.style.height).toBe('200px') // cap — beyond it the textarea scrolls
  })
})

describe('Composer — autocomplétion des slash commands', () => {
  test('taper /rev affiche l’option review', () => {
    renderComposer({ commands: CMDS })
    type('/rev')
    expect(options()).toHaveLength(1)
    expect(options()[0]?.textContent).toContain('review')
  })

  test('taper /brain trouve la commande namespacée par son ALIAS', () => {
    renderComposer({ commands: CMDS })
    type('/brain')
    expect(options().map((o) => o.textContent)).toHaveLength(1)
    expect(options()[0]?.textContent).toContain('superpowers:brainstorming')
  })

  test('Enter complète sans envoyer quand le popover est ouvert', () => {
    const { sent } = renderComposer({ commands: CMDS })
    type('/rev')
    expect(options()).toHaveLength(1)
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sent).toEqual([]) // rien n'est parti
    expect((textarea() as HTMLTextAreaElement).value).toBe('/review ')
  })

  test('Tab complète comme Enter', () => {
    const { sent } = renderComposer({ commands: CMDS })
    type('/rev')
    fireEvent.keyDown(textarea(), { key: 'Tab' })
    expect(sent).toEqual([])
    expect((textarea() as HTMLTextAreaElement).value).toBe('/review ')
  })

  test('un clic sur une option complète', () => {
    renderComposer({ commands: CMDS })
    type('/rev')
    fireEvent.mouseDown(options()[0]!)
    expect((textarea() as HTMLTextAreaElement).value).toBe('/review ')
  })

  test('↓ puis Enter sélectionne la DEUXIÈME option', () => {
    renderComposer({ commands: CMDS })
    type('/')
    expect(options()).toHaveLength(2)
    fireEvent.keyDown(textarea(), { key: 'ArrowDown' })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect((textarea() as HTMLTextAreaElement).value).toBe('/superpowers:brainstorming ')
  })

  test('zéro résultat : Enter envoie', () => {
    const { sent } = renderComposer({ commands: CMDS })
    type('/zzz')
    expect(options()).toHaveLength(0)
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sent).toEqual(['/zzz'])
  })

  test('⌘↵ envoie même popover ouvert', () => {
    const { sent } = renderComposer({ commands: CMDS })
    type('/rev')
    expect(options()).toHaveLength(1)
    fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true })
    expect(sent).toEqual(['/rev'])
  })

  test('Esc ferme le popover en gardant le texte', () => {
    renderComposer({ commands: CMDS })
    type('/rev')
    fireEvent.keyDown(textarea(), { key: 'Escape' })
    expect(options()).toHaveLength(0)
    expect((textarea() as HTMLTextAreaElement).value).toBe('/rev')
  })

  test('un chemin en milieu de phrase n’ouvre pas le popover', () => {
    renderComposer({ commands: CMDS })
    type('regarde src/foo')
    expect(options()).toHaveLength(0)
  })

  test('prop commands vide : jamais de popover', () => {
    renderComposer({ commands: [] })
    type('/rev')
    expect(options()).toHaveLength(0)
  })

  test('Shift+Enter popover ouvert insère une nouvelle ligne : ne complète pas, n’envoie pas', () => {
    const { sent } = renderComposer({ commands: CMDS })
    type('/rev')
    expect(options()).toHaveLength(1)
    fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true })
    expect(sent).toEqual([])
    expect((textarea() as HTMLTextAreaElement).value).not.toBe('/review ')
  })
})
