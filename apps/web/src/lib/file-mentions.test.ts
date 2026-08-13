import { describe, expect, test } from 'bun:test'
import { completeMention, insertMention, matchFiles, mentionPrefix, type FileEntry } from './file-mentions'

const f = (path: string): FileEntry => ({ path, dir: false })
const d = (path: string): FileEntry => ({ path, dir: true })

describe('mentionPrefix', () => {
  test('@ en début de texte', () => expect(mentionPrefix('@src', 4)).toBe('src'))
  test('@ après un espace, en pleine phrase', () => expect(mentionPrefix('regarde @comp', 13)).toBe('comp'))
  test('@ après un retour ligne', () => expect(mentionPrefix('titre\n@a', 8)).toBe('a'))
  test('@ seul (préfixe vide) déclenche', () => expect(mentionPrefix('@', 1)).toBe(''))
  test('email : @ collé à un mot ne déclenche PAS', () => expect(mentionPrefix('mail a@b', 8)).toBeNull())
  test('pas de @ avant le caret', () => expect(mentionPrefix('hello', 5)).toBeNull())
  test('caret revenu AVANT le @ : null', () => expect(mentionPrefix('x @src', 1)).toBeNull())
  test('caret 0 : null même si le texte commence par @', () => expect(mentionPrefix('@src', 0)).toBeNull())
  test('espace entre @ et caret : token clos, null', () => expect(mentionPrefix('@src ok', 7)).toBeNull())
  test('caret au milieu du token : préfixe partiel', () => expect(mentionPrefix('@src/lib', 4)).toBe('src'))
})

describe('matchFiles', () => {
  const ENTRIES = [f('README.md'), f('src/lib/utils.ts'), f('src/été.ts'), d('src'), d('src/lib')]
  test('préfixe vide : tout sort, ordre préservé', () => {
    expect(matchFiles(ENTRIES, '')).toEqual(ENTRIES)
  })
  test('palier 1 : chemin ou nom de base COMMENCE par la requête', () => {
    expect(matchFiles(ENTRIES, 'utils')[0]).toEqual(f('src/lib/utils.ts'))
  })
  test('palier 2 : sous-chaîne du chemin', () => {
    expect(matchFiles(ENTRIES, 'ib/ut')).toEqual([f('src/lib/utils.ts')])
  })
  test('palier 3 : sous-séquence', () => {
    expect(matchFiles(ENTRIES, 'sluts')).toEqual([f('src/lib/utils.ts')])
  })
  test('insensible à la casse', () => {
    expect(matchFiles(ENTRIES, 'readme')).toEqual([f('README.md')])
  })
  test('aucun match : vide', () => expect(matchFiles(ENTRIES, 'zzz')).toEqual([]))
  test('limite à 15 résultats', () => {
    const many = Array.from({ length: 30 }, (_, i) => f(`file-${String(i).padStart(2, '0')}.ts`))
    expect(matchFiles(many, 'file')).toHaveLength(15)
  })
})

describe('completeMention', () => {
  test('fichier : remplace le token et ajoute un espace', () => {
    expect(completeMention('vois @RE puis', 8, f('README.md')))
      .toEqual({ text: 'vois @README.md  puis', caret: 16 })
  })
  test('dossier : slash final, pas d’espace (on continue à taper dedans)', () => {
    expect(completeMention('@sr', 3, d('src'))).toEqual({ text: '@src/', caret: 5 })
  })
  test('en fin de texte', () => {
    expect(completeMention('lis @ut', 7, f('src/lib/utils.ts')))
      .toEqual({ text: 'lis @src/lib/utils.ts ', caret: 22 })
  })
})

describe('insertMention', () => {
  test('début de texte : pas d’espace de tête, espace de fin', () => {
    expect(insertMention('', 0, '.atelier/uploads/a.png'))
      .toEqual({ text: '@.atelier/uploads/a.png ', caret: 24 })
  })
  test('après un blanc : pas d’espace de tête', () => {
    expect(insertMention('voici ', 6, 'a.png'))
      .toEqual({ text: 'voici @a.png ', caret: 13 })
  })
  test('après un mot non-blanc : espace de tête ajouté', () => {
    expect(insertMention('voici', 5, 'a.png'))
      .toEqual({ text: 'voici @a.png ', caret: 13 })
  })
  test('insertion au caret au milieu du texte', () => {
    expect(insertMention('a b', 1, 'x.png'))
      .toEqual({ text: 'a @x.png  b', caret: 9 })
  })
})
