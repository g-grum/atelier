import { describe, expect, test } from 'bun:test'
import { buildFixPrompt, buildItemPrompt, buildReReviewPrompt, buildRetryPrompt, buildRetryVerdictPrompt, buildReviewPrompt } from './item-prompt'

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

describe('buildReviewPrompt', () => {
  const prompt = buildReviewPrompt({
    issue: 42,
    title: 'Ajouter un bouton',
    body: 'Le bouton doit être bleu.',
    branch: 'autopilot/42',
    verdictPath: '/repo/.worktrees/review-42.json',
  })

  test('contient le contexte de l’issue et de la branche', () => {
    expect(prompt).toContain('#42')
    expect(prompt).toContain('Ajouter un bouton')
    expect(prompt).toContain('Le bouton doit être bleu.')
    expect(prompt).toContain('autopilot/42')
  })

  test('contient la méthode : diff complet et les deux gates', () => {
    expect(prompt).toContain('git diff main...HEAD')
    expect(prompt).toContain('bun test')
    expect(prompt).toContain('tsc --noEmit -p apps/web')
  })

  test('contient le chemin du verdict et les interdits', () => {
    expect(prompt).toContain('/repo/.worktrees/review-42.json')
    expect(prompt).toContain('committer, pousser, merger')
    expect(prompt).toContain('aucune trace')
  })

  test('un corps vide ne laisse pas de trou', () => {
    const p = buildReviewPrompt({ issue: 7, title: 'T', body: '', branch: 'autopilot/7', verdictPath: '/v.json' })
    expect(p).toContain('(pas de description)')
  })
})

describe('buildReReviewPrompt', () => {
  test('contient le chemin du verdict et les gates', () => {
    const p = buildReReviewPrompt('/repo/.worktrees/review-42.json')
    expect(p).toContain('/repo/.worktrees/review-42.json')
    expect(p).toContain('git diff main...HEAD')
    expect(p).toContain('bun test')
    expect(p).toContain('tsc --noEmit -p apps/web')
  })
})

describe('buildFixPrompt', () => {
  test('contient chaque finding et l’interdiction de merger', () => {
    const p = buildFixPrompt([
      { title: 'Test manquant', detail: 'le cas vide n’est pas couvert' },
      { title: 'Bug de bord', detail: 'crash sur tableau vide' },
    ])
    expect(p).toContain('Test manquant')
    expect(p).toContain('le cas vide n’est pas couvert')
    expect(p).toContain('Bug de bord')
    expect(p).toContain('crash sur tableau vide')
    expect(p).toContain('Ne merge JAMAIS')
  })
})

describe('buildRetryVerdictPrompt', () => {
  test('contient le chemin du verdict', () => {
    const p = buildRetryVerdictPrompt('/repo/.worktrees/review-42.json')
    expect(p).toContain('/repo/.worktrees/review-42.json')
  })
})
