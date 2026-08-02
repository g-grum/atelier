import { describe, expect, test } from 'bun:test'
import { commandPrefix, completeCommand, matchCommands } from './slash-commands'

const CMDS = [
  { name: 'review', description: '', argumentHint: '', aliases: [] },
  { name: 'superpowers:brainstorming', description: '', argumentHint: '', aliases: ['brainstorming'] },
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
})

describe('completeCommand', () => {
  test('complète et ajoute une espace quand il n’y a pas de reste', () => {
    expect(completeCommand('/rev', 'review')).toBe('/review ')
  })
  test('remplace le PREMIER TOKEN SEULEMENT et préserve le reste', () => {
    expect(completeCommand('/rev mon-fichier', 'review')).toBe('/review mon-fichier')
  })
})
