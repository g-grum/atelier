# Mentions de fichiers (@) — Plan d'implémentation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Taper `@` dans le composer ouvre une autocomplétion fuzzy des fichiers/dossiers du projet courant ; la sélection insère `@chemin` dans le texte (l'agent lit le fichier via ses outils).

**Architecture:** Nouvel endpoint `GET /api/projects/:id/files` (git ls-files via le seam `GitRun` existant, fallback `Bun.Glob`) ; module pur `file-mentions.ts` miroir de `slash-commands.ts` ; second popover dans `Composer.tsx` réutilisant la mécanique clavier existante. Spec : `docs/specs/2026-08-12-file-mentions-design.md`.

**Tech Stack:** Bun (workspaces, `bun test`), Hono, React 19, TanStack Query, @testing-library/react (happy-dom).

**Conventions repo:** commits en français, style `feat(scope): …` / `test(scope): …`. AUCUNE attribution IA dans les commits. Tests : `bun test <chemin>` depuis la racine.

## Chunk 1: Serveur + type partagé

### Task 1: Type partagé `ProjectFileList`

**Files:**
- Modify: `packages/shared/src/protocol.ts` (ajouter près de `Project`, ligne ~29)

- [ ] **Step 1: Ajouter le type**

```ts
/** Listing des fichiers d'un projet — l'autocomplétion @ du composer (spec 2026-08-12). */
export type ProjectFileList = { files: string[]; dirs: string[] }
```

- [ ] **Step 2: Vérifier le typecheck**

Aucun script `typecheck` n'existe dans le repo (vérifié) — utiliser tsc directement :

Run: `bunx tsc --noEmit -p apps/server/tsconfig.json && bunx tsc --noEmit -p apps/web/tsconfig.json`
Expected: vert. (Cette commande est LA commande typecheck pour tout le plan.)

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/protocol.ts
git commit -m "feat(shared): type ProjectFileList pour le listing fichiers"
```

### Task 2: Listing serveur — `listProjectFiles` + route

**Files:**
- Create: `apps/server/src/files/files-routes.ts`
- Create: `apps/server/src/files/files-routes.test.ts`
- Modify: `apps/server/src/app.ts` (import + `api.route('/', filesRoutes(data))` après la ligne 43 `commandsRoutes`)

Le seam subprocess existe déjà : `GitRun` / `createGitRunner` dans `apps/server/src/github/git-remote.ts` (timeout 5 s intégré). On l'injecte comme `githubRoutes` le fait (`github-routes.ts:10`).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// apps/server/src/files/files-routes.test.ts
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitRun } from '../github/git-remote'
import { AppData } from '../store/app-data'
import { filesRoutes } from './files-routes'

/** AppData réel sur un tmpdir jetable (même motif que commands-routes.test.ts:12-16). */
function freshRoutes(gitRun: GitRun, projectPath = '/tmp/p1') {
  const data = new AppData(join(mkdtempSync(join(tmpdir(), 'atelier-files-')), 'data.json'))
  data.update((d) => { d.projects.push({ id: 'p1', path: projectPath, color: '#ffffff' }) })
  return filesRoutes(data, gitRun)
}

/** GitRun factice : renvoie la sortie NUL-séparée fournie (exitCode 0). */
const gitOk = (files: string[]): GitRun => async () => ({ stdout: files.join('\0'), stderr: '', exitCode: 0 })
const gitFail: GitRun = async () => ({ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 })

describe('GET /projects/:id/files', () => {
  test('fichiers triés + dossiers dérivés, chemins accentués intacts (NUL-séparé)', async () => {
    const app = freshRoutes(gitOk(['src/été.ts', 'src/lib/utils.ts', 'README.md']))
    const res = await app.request('/projects/p1/files')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      files: ['README.md', 'src/lib/utils.ts', 'src/été.ts'],
      dirs: ['src', 'src/lib'],
    })
  })

  test('404 sur projet inconnu', async () => {
    const app = freshRoutes(gitOk([]))
    expect((await app.request('/projects/nope/files')).status).toBe(404)
  })

  test('fallback glob quand git échoue (répertoire non-git), .git/node_modules exclus', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atelier-nogit-'))
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, 'src', 'a.ts'), '')
    writeFileSync(join(root, 'node_modules', 'x', 'b.js'), '')
    writeFileSync(join(root, '.git', 'HEAD'), '')
    const app = freshRoutes(gitFail, root)
    const res = await app.request('/projects/p1/files')
    expect(await res.json()).toEqual({ files: ['src/a.ts'], dirs: ['src'] })
  })

  test('200 avec listes vides quand git ET le fallback échouent (path inexistant)', async () => {
    const app = freshRoutes(gitFail, '/nonexistent/nope')
    const res = await app.request('/projects/p1/files')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: [], dirs: [] })
  })
})
```

- [ ] **Step 2: Vérifier l'échec**

Run: `bun test apps/server/src/files/files-routes.test.ts`
Expected: FAIL — `Cannot find module './files-routes'`.

- [ ] **Step 3: Implémenter**

```ts
// apps/server/src/files/files-routes.ts
import { Hono } from 'hono'
import type { ProjectFileList } from '@atelier/shared'
import { createGitRunner, type GitRun } from '../github/git-remote'
import type { AppData } from '../store/app-data'

/** Plafond global de la réponse (spec) — fichiers prioritaires, dossiers en remplissage. */
const MAX_ENTRIES = 20_000

/**
 * Listing des fichiers d'un projet pour l'autocomplétion @ du composer.
 * `git ls-files -z` (respecte .gitignore, inclut les non-suivis, NUL-séparé
 * pour éviter le C-quoting des chemins accentués) ; fallback Bun.Glob hors
 * repo git. Dossiers dérivés des chemins AVANT troncature (spec).
 */
export async function listProjectFiles(run: GitRun, path: string): Promise<ProjectFileList> {
  const result = await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], path)
  const files = result.exitCode === 0
    ? result.stdout.split('\0').filter((f) => f !== '')
    : await globFallback(path)
  files.sort()
  const dirs = deriveDirs(files)
  const cappedFiles = files.slice(0, MAX_ENTRIES)
  return { files: cappedFiles, dirs: dirs.slice(0, MAX_ENTRIES - cappedFiles.length) }
}

/** Ensemble des dossiers parents (sans slash final), triés. */
function deriveDirs(files: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const file of files) {
    let slash = file.indexOf('/')
    while (slash !== -1) {
      dirs.add(file.slice(0, slash))
      slash = file.indexOf('/', slash + 1)
    }
  }
  return [...dirs].sort()
}

/** Hors repo git : parcours glob en excluant les répertoires générés. */
async function globFallback(root: string): Promise<string[]> {
  const out: string[] = []
  try {
    for await (const file of new Bun.Glob('**/*').scan({ cwd: root })) {
      if (file.startsWith('.git/') || file.includes('node_modules/') || /^dist[^/]*\//.test(file)) continue
      out.push(file)
      if (out.length >= MAX_ENTRIES) break
    }
  } catch {
    return []
  }
  return out
}

/**
 * Résolution de l'id inlinée comme commands-routes.ts:17-20 (aucun résolveur
 * partagé au HEAD). Échec du listing ⇒ listes vides, jamais de 500 : sans
 * liste, le composer redevient une textarea ordinaire.
 */
export function filesRoutes(data: AppData, gitRun: GitRun = createGitRunner()): Hono {
  const app = new Hono()

  app.get('/projects/:id/files', async (c) => {
    const { id } = c.req.param()
    const project = data.get().projects.find((p) => p.id === id)
    if (!project) return c.json({ error: 'Not found' }, 404)
    try {
      return c.json(await listProjectFiles(gitRun, project.path))
    } catch {
      return c.json({ files: [], dirs: [] })
    }
  })

  return app
}
```

Note : `Bun.Glob.scan` ne renvoie que des fichiers par défaut (`onlyFiles: true`) et ne traverse pas `.git` caché ? — SI, il le traverse : `scan` sans `dot: true` ignore les entrées dotfiles, donc `.git/` est déjà exclu par défaut ; le garde `startsWith('.git/')` est une ceinture. `node_modules` en revanche DOIT être filtré manuellement.

- [ ] **Step 4: Vérifier que les tests passent**

Run: `bun test apps/server/src/files/files-routes.test.ts`
Expected: 4 pass. Si le test « fallback glob » renvoie aussi des dotfiles, ajuster le filtre (voir note ci-dessus) ; si `data.update` diffère de la signature utilisée dans `commands-routes.test.ts`, copier exactement ce que fait ce fichier.

- [ ] **Step 5: Monter la route + test d'app**

Dans `apps/server/src/app.ts` : ajouter `import { filesRoutes } from './files/files-routes'` et, après `api.route('/', commandsRoutes(data, sdk))` (ligne 43) :

```ts
api.route('/', filesRoutes(data))
```

Run: `bun test apps/server`
Expected: tout vert (aucun test d'app existant ne casse).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/files packages/shared/src/protocol.ts apps/server/src/app.ts
git commit -m "feat(server): endpoint GET /projects/:id/files (git ls-files + fallback glob)"
```

## Chunk 2: Logique pure web

### Task 3: `file-mentions.ts` — prefix, match, complete

**Files:**
- Create: `apps/web/src/lib/file-mentions.ts`
- Create: `apps/web/src/lib/file-mentions.test.ts`

Miroir de `slash-commands.ts` (même dossier) : fonctions pures, zéro dépendance UI.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// apps/web/src/lib/file-mentions.test.ts
import { describe, expect, test } from 'bun:test'
import { completeMention, matchFiles, mentionPrefix, type FileEntry } from './file-mentions'

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
```

- [ ] **Step 2: Vérifier l'échec**

Run: `bun test apps/web/src/lib/file-mentions.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// apps/web/src/lib/file-mentions.ts

/** Un candidat de mention : chemin relatif POSIX, `dir` pour les dossiers (affichés/complétés avec `/`). */
export type FileEntry = { path: string; dir: boolean }

/** Assez pour choisir, pas de scroll infini — même esprit que le popover commandes. */
export const MAX_FILE_MATCHES = 15

/**
 * Le token de mention en cours de frappe, ou null. Déclencheur : un `@` avant
 * le caret, en début de texte ou précédé d'un blanc (évite les emails `a@b`),
 * sans blanc entre le `@` et le caret. Limitation connue (spec) : les chemins
 * contenant des espaces ne re-matchent pas si le caret y revient.
 */
export function mentionPrefix(text: string, caret: number): string | null {
  const at = text.lastIndexOf('@', caret - 1)
  if (at === -1) return null
  if (at > 0 && !/\s/.test(text[at - 1]!)) return null
  const token = text.slice(at + 1, caret)
  if (/\s/.test(token)) return null
  return token
}

/**
 * Paliers (comme matchCommands, slash-commands.ts:25) : P1 = chemin OU nom de
 * base COMMENCE par la requête, P2 = chemin CONTIENT, P3 = sous-séquence.
 * Insensible à la casse, ordre d'origine préservé dans chaque palier,
 * plafonné à MAX_FILE_MATCHES. Requête vide : tout matche P1.
 */
export function matchFiles(entries: readonly FileEntry[], prefix: string): FileEntry[] {
  const p = prefix.toLowerCase()
  const starts: FileEntry[] = []
  const contains: FileEntry[] = []
  const subsequence: FileEntry[] = []
  for (const entry of entries) {
    if (starts.length >= MAX_FILE_MATCHES) break
    const path = entry.path.toLowerCase()
    const base = path.slice(path.lastIndexOf('/') + 1)
    if (path.startsWith(p) || base.startsWith(p)) starts.push(entry)
    else if (path.includes(p)) contains.push(entry)
    else if (isSubsequence(p, path)) subsequence.push(entry)
  }
  return [...starts, ...contains, ...subsequence].slice(0, MAX_FILE_MATCHES)
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i++
    if (i >= needle.length) return true
  }
  return needle.length === 0
}

/**
 * Remplace le token `@…` (du `@` au caret) par la mention complète. Fichier :
 * `@chemin ` (espace, la phrase continue). Dossier : `@chemin/` sans espace —
 * le préfixe reste ouvert pour descendre dans l'arborescence.
 */
export function completeMention(text: string, caret: number, entry: FileEntry): { text: string; caret: number } {
  const at = text.lastIndexOf('@', caret - 1)
  const inserted = `@${entry.path}${entry.dir ? '/' : ' '}`
  return {
    text: text.slice(0, at) + inserted + text.slice(caret),
    caret: at + inserted.length,
  }
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `bun test apps/web/src/lib/file-mentions.test.ts`
Expected: tous verts. Attention au test `completeMention` « fichier » : `'vois @RE puis'` caret 8 → le texte résultant contient DEUX espaces (`'@README.md '` inséré + l'espace existant) — c'est voulu, vérifier que l'attendu du test correspond bien à l'implémentation avant de « corriger » l'un ou l'autre.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/file-mentions.ts apps/web/src/lib/file-mentions.test.ts
git commit -m "feat(web): logique pure des mentions de fichiers (@)"
```

## Chunk 3: Câblage API + Composer

### Task 4: Client API + Backend + App

**Files:**
- Modify: `apps/web/src/api/client.ts` (après `listCommands`, ligne ~177)
- Modify: `apps/web/src/api/backend.ts` (type `Backend` ligne ~44, `realBackend` ligne ~87, fixture ligne ~185)
- Modify: `apps/web/src/App.tsx` (après `commandsQuery`, ligne ~234 ; prop Composer ligne ~515)

Pas de test dédié : `client.ts` et le câblage react-query n'en ont pas dans ce repo (motif existant) ; la couverture vient des tests Composer (Task 5) et serveur (Task 2).

- [ ] **Step 1: `client.ts`**

```ts
/** Fichiers + dossiers du projet — l'autocomplétion @ du composer. */
export function listFiles(projectId: string): Promise<ProjectFileList> {
  return request<ProjectFileList>('GET', `/projects/${encodeURIComponent(projectId)}/files`)
}
```

Ajouter `ProjectFileList` à l'import de types `@atelier/shared` en tête de fichier.

- [ ] **Step 2: `backend.ts`**

Dans le type `Backend`, après `listCommands` :

```ts
  /** Fichiers du projet — alimente l'autocomplétion @ du composer. */
  listFiles: (projectId: string) => Promise<ProjectFileList>
```

Dans `realBackend` : `listFiles: client.listFiles,` — dans `createFixtureBackend` (après `listCommands`, même commentaire d'esprit) :

```ts
    // Mode démo : pas de projet réel sur disque → pas d'autocomplétion fichiers.
    listFiles: async () => ({ files: [], dirs: [] }),
```

Ajouter `ProjectFileList` à l'import de types `@atelier/shared`.

- [ ] **Step 3: `App.tsx`**

Après le bloc `commandsQuery` (ligne ~234) :

```ts
  // Fichiers du projet pour l'autocomplétion @ (spec 2026-08-12). staleTime
  // court (le repo bouge pendant la session), silencieux sur échec — sans
  // liste, @ ne déclenche simplement rien.
  const filesQuery = useQuery({
    queryKey: ['files', commandsProjectId],
    queryFn: () => backend.listFiles(commandsProjectId ?? ''),
    enabled: commandsProjectId !== null,
    staleTime: 30_000,
    retry: false,
  })
  // Fusion { files, dirs } → FileEntry[] mémoïsée : une prop stable pour Composer.
  const fileEntries = useMemo<FileEntry[]>(() => {
    const list = filesQuery.data
    if (list === undefined) return []
    return [
      ...list.files.map((path) => ({ path, dir: false })),
      ...list.dirs.map((path) => ({ path, dir: true })),
    ]
  }, [filesQuery.data])
```

Imports : `useMemo` (déjà importé ? vérifier), `type { FileEntry } from './lib/file-mentions'`. Sur le `<Composer …>` (ligne ~515) ajouter `files={fileEntries}`.

- [ ] **Step 4: Tests web + typecheck**

Run: `bun test apps/web` — Expected: PASS (bun ne typecheck pas, et React ignore la prop `files` en trop passée au Composer non modifié).
Run: `bunx tsc --noEmit -p apps/web/tsconfig.json` — Expected: FAIL sur `files` inconnue dans `ComposerProps` — c'est attendu jusqu'à la Task 5. Toute AUTRE erreur (backend, client, App) se corrige ICI.

**Ne PAS commit** — commit commun avec Task 5 (le typecheck n'est pas vert sans la prop côté Composer).

### Task 5: Composer — popover @

**Files:**
- Modify: `apps/web/src/components/Composer.tsx`
- Modify: `apps/web/src/components/Composer.test.tsx`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `Composer.test.tsx` (réutilise `renderComposer`, `type()`, `options()` existants ; `renderComposer` doit recevoir `files: []` par défaut dans ses props — l'ajouter au littéral `props`) :

```tsx
// ORDRE IMPORTANT : le dossier 'src' AVANT 'src/lib/utils.ts' — les deux sont
// au palier 1 pour '@sr', et le test « dossier » complète l'option active (0).
const FILES = [
  { path: 'README.md', dir: false },
  { path: 'src', dir: true },
  { path: 'src/lib/utils.ts', dir: false },
]

describe('mentions de fichiers (@)', () => {
  test('@ ouvre le popover fichiers ; Enter complète avec le chemin + espace', () => {
    renderComposer({ files: FILES })
    type('regarde @ut')
    expect(options()).toHaveLength(1)
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect((textarea() as HTMLTextAreaElement).value).toBe('regarde @src/lib/utils.ts ')
  })

  test('dossier : complétion avec / final, le popover reste ouvert sur les enfants', () => {
    renderComposer({ files: FILES })
    type('@sr')
    fireEvent.keyDown(textarea(), { key: 'Tab' })
    expect((textarea() as HTMLTextAreaElement).value).toBe('@src/')
    // préfixe 'src/' toujours actif → utils.ts (sous-chaîne) reste proposé
    expect(options().length).toBeGreaterThan(0)
  })

  test('email : pas de popover sur a@b', () => {
    renderComposer({ files: FILES })
    type('mail a@b')
    expect(options()).toHaveLength(0)
  })

  test('Escape ferme le popover fichiers sans envoyer', () => {
    const { sent } = renderComposer({ files: FILES })
    type('@RE')
    fireEvent.keyDown(textarea(), { key: 'Escape' })
    expect(options()).toHaveLength(0)
    expect(sent).toEqual([])
  })

  test('liste vide : @ ne déclenche rien (dégradation silencieuse)', () => {
    renderComposer({ files: [] })
    type('@src')
    expect(options()).toHaveLength(0)
  })

  test('le popover commandes garde la priorité sur /', () => {
    renderComposer({ files: FILES, commands: CMDS })
    type('/rev')
    expect(options()[0]?.textContent).toContain('/review')
  })
})
```

- [ ] **Step 2: Vérifier l'échec**

Run: `bun test apps/web/src/components/Composer.test.tsx`
Expected: FAIL (prop `files` inconnue, popover absent).

- [ ] **Step 3: Implémenter dans `Composer.tsx`**

1. Props : ajouter à `ComposerProps` —

```ts
  /** Fichiers/dossiers du projet pour l'autocomplétion @. Vide ⇒ pas de popover. */
  files: FileEntry[]
```

Import : `import { completeMention, matchFiles, mentionPrefix, type FileEntry } from '../lib/file-mentions'`.

2. Dérivation (remplace les lignes 36-38) — le popover commandes garde la priorité, un seul popover à la fois :

```ts
  const cmdPrefix = dismissed ? null : commandPrefix(text, caret)
  const cmdMatches = cmdPrefix === null ? [] : matchCommands(commands, cmdPrefix)
  const filePrefix = dismissed || cmdMatches.length > 0 ? null : mentionPrefix(text, caret)
  const fileMatches = filePrefix === null ? [] : matchFiles(files, filePrefix)
  const matches = cmdMatches.length > 0 ? cmdMatches : fileMatches
  const open = matches.length > 0
```

`matches.length` reste la base de la navigation clavier existante (lignes 129-150) — le handler `ArrowDown/ArrowUp/Escape` ne change pas. `Enter`/`Tab` (ligne 140-144) devient :

```ts
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                if (cmdMatches.length > 0) complete(cmdMatches[active]!.name)
                else completeFile(fileMatches[active]!)
                return
              }
```

3. `completeFile` (à côté de `complete`, ligne 46) :

```ts
  const completeFile = (entry: FileEntry) => {
    const next = completeMention(text, caret, entry)
    setText(next.text)
    setCaret(next.caret)
    // Fichier : fermer (le chemin complété rematcherait). Dossier : rester
    // ouvert pour descendre dans l'arborescence.
    setDismissed(!entry.dir)
    setActive(0)
    const el = textareaRef.current
    el?.focus()
    // React replace la valeur ⇒ le caret DOM saute en fin ; on le repose au
    // point d'insertion (mention en milieu de phrase). happy-dom : optionnel.
    requestAnimationFrame(() => el?.setSelectionRange?.(next.caret, next.caret))
  }
```

4. Rendu : le `<ul className="command-popover">` existant est rendu quand `cmdMatches.length > 0` ; ajouter un second bloc pour les fichiers (mêmes classes CSS — le style existe déjà) :

```tsx
      {open && cmdMatches.length === 0 && (
        <ul className="command-popover" role="listbox" aria-label="Fichiers du projet">
          {fileMatches.map((entry, index) => (
            <li
              key={entry.path}
              ref={index === active ? activeRef : undefined}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'active' : undefined}
              onMouseMove={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault()
                completeFile(entry)
              }}
            >
              <span className="cmd-name">{entry.path}{entry.dir ? '/' : ''}</span>
            </li>
          ))}
        </ul>
      )}
```

Et conditionner le popover commandes existant à `cmdMatches.length > 0` (au lieu de `open`).

5. Réinitialisation `active` : le `onChange` existant fait déjà `setActive(0)` — rien à ajouter.

- [ ] **Step 4: Vérifier que tout passe**

Run: `bun test apps/web`
Expected: tout vert, y compris les tests slash-commands existants (non-régression : la dérivation refactorée doit garder leur comportement à l'identique).

- [ ] **Step 5: Typecheck complet**

Run: `bunx tsc --noEmit -p apps/server/tsconfig.json && bunx tsc --noEmit -p apps/web/tsconfig.json`
Expected: vert.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/api/backend.ts apps/web/src/App.tsx apps/web/src/components/Composer.tsx apps/web/src/components/Composer.test.tsx
git commit -m "feat(web): autocomplétion @ des fichiers du projet dans le composer"
```

### Task 6: Vérification finale

- [ ] **Step 1: Suite complète**

Run: `bun test`
Expected: tout vert.

- [ ] **Step 2: Vérification manuelle (spec §Flux)**

Lancer l'app (voir MEMORY : vérifier le port 4517 et `jobs state.json` avant — ne pas tuer un serveur existant sans identifier son propriétaire). Dans une session sur un projet réel : taper `@comp` → le popover liste `Composer.tsx` ; Enter → `@apps/web/src/components/Composer.tsx ` inséré ; envoyer « résume @<fichier> » → l'agent lit le fichier via Read.
