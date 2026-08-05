import { describe, expect, test } from 'bun:test'
import { buildItemPrompt, buildRetryPrompt } from './item-prompt'

describe('buildItemPrompt', () => {
  const prompt = buildItemPrompt({ issue: 42, title: 'Ajouter un bouton', body: 'Le bouton doit être bleu.', branch: 'autopilot/42' })

  test('contient le contexte de l’issue', () => {
    expect(prompt).toContain('#42')
    expect(prompt).toContain('Ajouter un bouton')
    expect(prompt).toContain('Le bouton doit être bleu.')
    expect(prompt).toContain('autopilot/42')
  })

  test('contient la consigne de PR liée à l’issue', () => {
    expect(prompt).toContain('Closes #42')
    expect(prompt).toContain('gh pr create')
  })

  test('contient les gates du repo et la consigne d’autonomie', () => {
    expect(prompt).toContain('bun test')
    expect(prompt).toContain('tsc --noEmit -p apps/web')
    expect(prompt).toContain('ne pose aucune question')
  })

  test('un corps vide ne laisse pas de trou', () => {
    const p = buildItemPrompt({ issue: 7, title: 'T', body: '', branch: 'autopilot/7' })
    expect(p).toContain('(pas de description)')
  })
})

describe('buildRetryPrompt', () => {
  test('rappelle gates puis PR', () => {
    const p = buildRetryPrompt(42)
    expect(p).toContain('gates')
    expect(p).toContain('Closes #42')
  })
})
