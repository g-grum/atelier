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

const WITH_PREVIEW: QuestionChatItem = {
  ...MONO,
  questions: [
    {
      ...MONO.questions[0]!,
      options: [
        { label: 'A', description: 'la première', preview: 'aperçu de A' },
        { label: 'B', description: 'la seconde' },
      ],
    },
  ],
}

const MULTI_PREVIEW: QuestionChatItem = {
  ...MONO,
  questions: [
    {
      question: 'Quelles plateformes ?',
      header: 'Plateformes',
      options: [
        { label: 'macOS', description: 'm', preview: 'brew install atelier' },
        { label: 'Linux', description: 'l' },
      ],
      multiSelect: true,
    },
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

  test('résolu answered multiSelect : label contenant une virgule correctement surligné', () => {
    const item: QuestionChatItem = {
      ...MONO,
      questions: [
        {
          question: 'Quels modes ?',
          header: 'Modes',
          options: [
            { label: 'Oui, toujours', description: 'o' },
            { label: 'toujours', description: 't' },
            { label: 'Non', description: 'n' },
          ],
          multiSelect: true,
        },
      ],
      resolved: 'answered',
      answers: { 'Quels modes ?': 'Oui, toujours, Non' },
    }
    render(<QuestionPrompt item={item} onAnswer={mock()} />)
    expect(screen.getByRole('button', { name: /Oui, toujours/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Non/ }).getAttribute('aria-pressed')).toBe('true')
    // « toujours » seul n'a PAS été choisi — le split naïf par virgule le surlignerait à tort.
    expect(screen.getByRole('button', { name: /^toujours/ }).getAttribute('aria-pressed')).toBe('false')
  })

  test('résolu dismissed : mention « Répondu dans le chat »', () => {
    render(<QuestionPrompt item={{ ...MONO, resolved: 'dismissed' }} onAnswer={mock()} />)
    expect(screen.getByText('Répondu dans le chat')).toBeTruthy()
  })

  test('preview : le survol d’une option l’affiche, la sortie replie la zone (contenu monté pour l’animation)', () => {
    const { container } = render(<QuestionPrompt item={WITH_PREVIEW} onAnswer={mock()} />)
    expect(screen.queryByText('aperçu de A')).toBeNull()
    const option = screen.getByRole('button', { name: /la première/ })
    fireEvent.mouseOver(option)
    expect(screen.getByText('aperçu de A')).toBeTruthy()
    expect(container.querySelector('.q-preview-zone.open')).toBeTruthy()
    fireEvent.mouseOut(option)
    // La zone se replie (plus 'open') mais le contenu RESTE monté le temps de la
    // transition grid 1fr→0fr — une rangée vide mesurerait 0 et couperait net.
    expect(container.querySelector('.q-preview-zone.open')).toBeNull()
    expect(screen.getByText('aperçu de A')).toBeTruthy()
  })

  test('preview : le focus clavier l’affiche, le blur replie la zone', () => {
    const { container } = render(<QuestionPrompt item={WITH_PREVIEW} onAnswer={mock()} />)
    const option = screen.getByRole('button', { name: /la première/ })
    fireEvent.focus(option)
    expect(screen.getByText('aperçu de A')).toBeTruthy()
    expect(container.querySelector('.q-preview-zone.open')).toBeTruthy()
    fireEvent.blur(option)
    expect(container.querySelector('.q-preview-zone.open')).toBeNull()
  })

  test('preview : la résolution ignore le survol figé (boutons disabled = plus de mouseleave)', () => {
    const { container, rerender } = render(<QuestionPrompt item={WITH_PREVIEW} onAnswer={mock()} />)
    fireEvent.mouseOver(screen.getByRole('button', { name: /la première/ }))
    expect(container.querySelector('.q-preview-zone.open')).toBeTruthy()
    // Répondu dans le chat pendant le survol : la carte gèle, la preview du survol ne colle pas.
    rerender(<QuestionPrompt item={{ ...WITH_PREVIEW, resolved: 'dismissed' }} onAnswer={mock()} />)
    expect(container.querySelector('.q-preview-zone.open')).toBeNull()
  })

  test('preview : résolu answered pendant un survol, c’est la preview de la RÉPONSE qui s’affiche', () => {
    const { rerender } = render(<QuestionPrompt item={WITH_PREVIEW} onAnswer={mock()} />)
    fireEvent.mouseOver(screen.getByRole('button', { name: /la seconde/ }))
    rerender(
      <QuestionPrompt
        item={{ ...WITH_PREVIEW, resolved: 'answered', answers: { 'Quelle approche ?': 'A' } }}
        onAnswer={mock()}
      />,
    )
    expect(screen.getByText('aperçu de A')).toBeTruthy()
  })

  test('preview : le survol d’une option sans preview n’affiche rien', () => {
    render(<QuestionPrompt item={WITH_PREVIEW} onAnswer={mock()} />)
    fireEvent.mouseOver(screen.getByRole('button', { name: /la seconde/ }))
    expect(screen.queryByText('aperçu de A')).toBeNull()
  })

  test('preview : conservée après mouse-out si l’option est sélectionnée', () => {
    render(<QuestionPrompt item={MULTI_PREVIEW} onAnswer={mock()} />)
    const option = screen.getByRole('button', { name: /macOS/ })
    fireEvent.click(option)
    expect(screen.getByText('brew install atelier')).toBeTruthy()
    fireEvent.mouseOver(option)
    fireEvent.mouseOut(option)
    expect(screen.getByText('brew install atelier')).toBeTruthy()
  })

  test('preview : résolu answered, la preview de la réponse reste affichée', () => {
    render(
      <QuestionPrompt
        item={{ ...WITH_PREVIEW, resolved: 'answered', answers: { 'Quelle approche ?': 'A' } }}
        onAnswer={mock()}
      />,
    )
    expect(screen.getByText('aperçu de A')).toBeTruthy()
  })

  test('a11y : role alert pendant pending seulement', () => {
    const { rerender } = render(<QuestionPrompt item={MONO} onAnswer={mock()} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    rerender(<QuestionPrompt item={{ ...MONO, resolved: 'dismissed' }} onAnswer={mock()} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
