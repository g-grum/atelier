import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MessageItem } from './MessageItem'

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

  test('bouton Copier : écrit le code dans le clipboard et affiche « Copié »', async () => {
    const writeText = mock(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<MessageItem role="assistant" text={'```ts\nconst a = 1\n```'} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copier' }))
    expect(writeText).toHaveBeenCalledWith('const a = 1\n')
    expect(await screen.findByText('Copié')).toBeTruthy()
  })
})
