import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QuestionPrompt, type QuestionChatItem } from './QuestionPrompt'

// RTL enveloppe rendus/événements dans act() — React 19 exige le flag hors preset de runner.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const MONO: QuestionChatItem = {
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

const MULTI: QuestionChatItem = {
  ...MONO,
  questions: [
    MONO.questions[0]!,
    { question: 'Quelles plateformes ?', header: 'Plateformes', options: [{ label: 'macOS', description: 'm' }, { label: 'Linux', description: 'l' }], multiSelect: true },
  ],
}

describe('QuestionPrompt', () => {
  test('rend chip, question, labels et descriptions', () => {
    render(<QuestionPrompt item={MONO} onAnswer={mock()} />)
    expect(screen.getByText('Approche')).toBeTruthy()
    expect(screen.getByText('Quelle approche ?')).toBeTruthy()
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('la première')).toBeTruthy()
  })

  test('mono-question single-select : le clic sur une option envoie directement', () => {
    const onAnswer = mock()
    render(<QuestionPrompt item={MONO} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: /la première/ }))
    expect(onAnswer).toHaveBeenCalledWith({ 'Quelle approche ?': 'A' })
  })

  test('mono-question : « Autre » ouvre le champ, l’envoi passe par le bouton', () => {
    const onAnswer = mock()
    render(<QuestionPrompt item={MONO} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: /Autre/ }))
    expect(onAnswer).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ma réponse' } })
    fireEvent.click(screen.getByRole('button', { name: /Envoyer/ }))
    expect(onAnswer).toHaveBeenCalledWith({ 'Quelle approche ?': 'ma réponse' })
  })

  test('multi-questions : bouton Envoyer inactif tant que tout n’est pas répondu', () => {
    const onAnswer = mock()
    render(<QuestionPrompt item={MULTI} onAnswer={onAnswer} />)
    const submit = screen.getByRole('button', { name: /Envoyer/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /la première/ }))
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /macOS/ }))
    fireEvent.click(screen.getByRole('button', { name: /Linux/ }))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledWith({ 'Quelle approche ?': 'A', 'Quelles plateformes ?': 'macOS, Linux' })
  })

  test('multiSelect : re-cliquer désélectionne', () => {
    render(<QuestionPrompt item={MULTI} onAnswer={mock()} />)
    const macos = screen.getByRole('button', { name: /macOS/ })
    fireEvent.click(macos)
    expect(macos.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(macos)
    expect(macos.getAttribute('aria-pressed')).toBe('false')
  })

  test('résolu answered : options figées, réponse mise en évidence', () => {
    render(<QuestionPrompt item={{ ...MONO, resolved: 'answered', answers: { 'Quelle approche ?': 'A' } }} onAnswer={mock()} />)
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Répondu')).toBeTruthy()
    // La réponse choisie est bien surlignée, et elle seule.
    expect(screen.getByRole('button', { name: /la première/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /la seconde/ }).getAttribute('aria-pressed')).toBe('false')
  })

  test('résolu dismissed : mention « Répondu dans le chat »', () => {
    render(<QuestionPrompt item={{ ...MONO, resolved: 'dismissed' }} onAnswer={mock()} />)
    expect(screen.getByText('Répondu dans le chat')).toBeTruthy()
  })

  test('a11y : role alert pendant pending seulement', () => {
    const { rerender } = render(<QuestionPrompt item={MONO} onAnswer={mock()} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    rerender(<QuestionPrompt item={{ ...MONO, resolved: 'dismissed' }} onAnswer={mock()} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
