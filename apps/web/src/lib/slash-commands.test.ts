import { describe, expect, test } from 'bun:test'
import { commandPrefix, completeCommand, matchCommands } from './slash-commands'

const CMDS = [
  { name: 'review', description: '', argumentHint: '', aliases: [] },
  { name: 'superpowers:brainstorming', description: '', argumentHint: '', aliases: ['brainstorming'] },
]

// Fixture de recherche : couvre les trois paliers (P1 préfixe nom/alias,
// P2 sous-chaîne nom/alias, P3 sous-chaîne description).
const SEARCH = [
  { name: 'review', description: 'relire une pull request', argumentHint: '', aliases: [] },
  { name: 'writing-plans', description: 'écrire un plan d\'implémentation', argumentHint: '', aliases: [] },
  { name: 'code-review', description: 'review the current diff', argumentHint: '', aliases: [] },
  { name: 'verify', description: 'exercise the change and review behavior', argumentHint: '', aliases: [] },
]

describe('commandPrefix', () => {
  test('renvoie le préfixe quand le brouillon commence par /', () => {
    expect(commandPrefix('/rev', 4)).toBe('rev')
  })
  test('renvoie une chaîne vide juste après le slash', () => {
    expect(commandPrefix('/', 1)).toBe('')
  })
  test('ne déclenche pas hors du premier mot', () => {
    expect(commandPrefix('/review mon-fichier', 19)).toBeNull()
  })
  test('déclenche si le curseur revient dans le premier mot', () => {
    expect(commandPrefix('/review mon-fichier', 4)).toBe('review')
  })
  test('ne déclenche pas sur un chemin en milieu de phrase', () => {
    expect(commandPrefix('regarde src/foo', 15)).toBeNull()
  })
})

describe('matchCommands', () => {
  test('filtre sur le nom', () => {
    expect(matchCommands(CMDS, 'rev').map((c) => c.name)).toEqual(['review'])
  })
  test('filtre AUSSI sur les alias', () => {
    expect(matchCommands(CMDS, 'brain').map((c) => c.name)).toEqual(['superpowers:brainstorming'])
  })
  test('renvoie tout sur préfixe vide', () => {
    expect(matchCommands(CMDS, '')).toHaveLength(2)
  })
  test('est insensible à la casse', () => {
    expect(matchCommands(CMDS, 'REV').map((c) => c.name)).toEqual(['review'])
  })

  test('P2 : sous-chaîne du nom — plan trouve writing-plans', () => {
    expect(matchCommands(SEARCH, 'plan').map((c) => c.name)).toEqual(['writing-plans'])
  })
  test('P2 : sous-chaîne d’un ALIAS — storm trouve la commande namespacée', () => {
    expect(matchCommands(CMDS, 'storm').map((c) => c.name)).toEqual(['superpowers:brainstorming'])
  })
  test('P3 : sous-chaîne de la description — diff trouve code-review', () => {
    expect(matchCommands(SEARCH, 'diff').map((c) => c.name)).toEqual(['code-review'])
  })
  test('ordre des paliers : P1 avant P2 avant P3', () => {
    // review : P1 = review (préfixe), P2 = code-review (le nom contient),
    // P3 = verify (seule la description contient).
    expect(matchCommands(SEARCH, 'review').map((c) => c.name)).toEqual(['review', 'code-review', 'verify'])
  })
  test('dédup : une commande matchant nom ET description sort une seule fois', () => {
    // writing-plans matche 'plan' par le nom (P2) ET par la description — un seul résultat.
    expect(matchCommands(SEARCH, 'plan')).toHaveLength(1)
  })
  test('la casse est ignorée aussi dans la description', () => {
    expect(matchCommands(SEARCH, 'DIFF').map((c) => c.name)).toEqual(['code-review'])
  })
  test('aucun match : liste vide', () => {
    expect(matchCommands(SEARCH, 'zzz')).toEqual([])
  })
  test("requête vide : tout le catalogue dans l'ordre d'origine", () => {
    expect(matchCommands(SEARCH, '').map((c) => c.name)).toEqual([
      'review',
      'writing-plans',
      'code-review',
      'verify',
    ])
  })
})

describe('completeCommand', () => {
  test("complète et ajoute une espace quand il n’y a pas de reste", () => {
    expect(completeCommand('/rev', 'review')).toBe('/review ')
  })
  test('remplace le PREMIER TOKEN SEULEMENT et préserve le reste', () => {
    expect(completeCommand('/rev mon-fichier', 'review')).toBe('/review mon-fichier')
  })
})
