import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageItem } from './MessageItem'

// RTL enveloppe rendus/événements dans act() — React 19 exige le flag hors preset de runner.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

describe('MessageItem markdown', () => {
  test('assistant : gras, titre et liste rendus en éléments HTML', () => {
    render(<MessageItem role="assistant" text={'# Titre\n\nDu **gras**\n\n- un item'} />)
    expect(screen.getByRole('heading', { name: 'Titre' })).toBeTruthy()
    expect(screen.getByText('gras').tagName).toBe('STRONG')
    expect(screen.getByRole('listitem').textContent).toBe('un item')
  })

  test('user : texte brut, la syntaxe markdown reste littérale', () => {
    render(<MessageItem role="user" text={'Du **gras** ici'} />)
    expect(screen.getByText('Du **gras** ici')).toBeTruthy()
    expect(document.querySelector('strong')).toBeNull()
  })

  test('assistant : bloc de code fencé → <code class="language-ts">', () => {
    render(<MessageItem role="assistant" text={'```ts\nconst a = 1\n```'} />)
    const code = document.querySelector('pre code')
    expect(code?.className).toContain('language-ts')
    expect(code?.textContent).toContain('const')
  })

  test('bouton Copier : écrit le code dans le clipboard et affiche « Copié »', async () => {
    const writeText = mock(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<MessageItem role="assistant" text={'```ts\nconst a = 1\n```'} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copier' }))
    expect(writeText).toHaveBeenCalledWith('const a = 1\n')
    expect(await screen.findByText('Copié')).toBeTruthy()
  })
})
