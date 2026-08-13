# Upload d'image dans le composer — Plan d'implémentation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coller / glisser-déposer / parcourir une image dans le composer ; le serveur l'écrit sous `.atelier/uploads/`, une référence `@chemin` est insérée dans le texte, l'agent lit l'image via Read.

**Architecture:** `POST /api/projects/:id/uploads` (multipart) via `c.req.formData()` + validation MIME/taille ; lib pure `image-uploads.ts` ; helper `insertMention` ajouté à `file-mentions.ts` ; trois entrées + état d'upload dans `Composer.tsx`. Spec : `docs/specs/2026-08-13-image-upload-design.md`.

**Tech Stack:** Bun (`bun test`), Hono, React 19, TanStack Query, @testing-library/react (happy-dom).

**Conventions repo:** commits FR `feat(scope): …`. AUCUNE attribution IA. Tests : `bun test <chemin>` depuis la racine. Typecheck : `bunx tsc --noEmit -p apps/server/tsconfig.json && bunx tsc --noEmit -p apps/web/tsconfig.json` (aucun script `typecheck`). `bun` via `export PATH="$HOME/.bun/bin:$PATH"`.

## Chunk 1: Serveur (lib pure + route)

### Task 1: Lib pure `image-uploads.ts`

**Files:**
- Create: `apps/server/src/uploads/image-uploads.ts`
- Create: `apps/server/src/uploads/image-uploads.test.ts`

- [ ] **Step 1: Tests qui échouent**

```ts
// apps/server/src/uploads/image-uploads.test.ts
import { describe, expect, test } from 'bun:test'
import { extensionForMime, MAX_IMAGE_BYTES } from './image-uploads'

describe('extensionForMime', () => {
  test('png/jpeg/gif/webp', () => {
    expect(extensionForMime('image/png')).toBe('png')
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('image/gif')).toBe('gif')
    expect(extensionForMime('image/webp')).toBe('webp')
  })
  test('non supporté → null', () => {
    expect(extensionForMime('image/svg+xml')).toBeNull()
    expect(extensionForMime('application/pdf')).toBeNull()
    expect(extensionForMime('')).toBeNull()
  })
})

test('MAX_IMAGE_BYTES = 10 Mo', () => {
  expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024)
})
```

- [ ] **Step 2: Vérifier l'échec** — `bun test apps/server/src/uploads/image-uploads.test.ts` → FAIL (module introuvable).

- [ ] **Step 3: Implémenter**

```ts
// apps/server/src/uploads/image-uploads.ts

/** MIME image supportés → extension de fichier (spec 2026-08-13). */
export const ALLOWED_IMAGE_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** Plafond de taille d'une image uploadée. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Extension pour un MIME image supporté, ou null. */
export function extensionForMime(mime: string): string | null {
  return ALLOWED_IMAGE_MIME[mime] ?? null
}
```

- [ ] **Step 4: Vérifier le vert** — `bun test apps/server/src/uploads/image-uploads.test.ts` → pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/uploads/image-uploads.ts apps/server/src/uploads/image-uploads.test.ts
git commit -m "feat(server): lib pure de validation des images uploadées"
```

### Task 2: Route `POST /projects/:id/uploads`

**Files:**
- Create: `apps/server/src/uploads/uploads-routes.ts`
- Create: `apps/server/src/uploads/uploads-routes.test.ts`
- Modify: `apps/server/src/app.ts` (import + `api.route('/', uploadsRoutes(data))` après `filesRoutes`)

Hono/Bun parse le multipart via `await c.req.formData()`. Résolution d'id inline (motif `files-routes.ts`).

- [ ] **Step 1: Tests qui échouent**

```ts
// apps/server/src/uploads/uploads-routes.test.ts
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from '../store/app-data'
import { uploadsRoutes } from './uploads-routes'

/** AppData réel sur tmpdir jetable + un projet dont le path est un tmpdir réel. */
function freshRoutes(withProject = true) {
  const data = new AppData(join(mkdtempSync(join(tmpdir(), 'atelier-up-')), 'data.json'))
  const projectPath = mkdtempSync(join(tmpdir(), 'atelier-proj-'))
  if (withProject) data.update((d) => { d.projects.push({ id: 'p1', path: projectPath, color: '#fff' }) })
  return { app: uploadsRoutes(data), projectPath }
}

/** Requête multipart avec un fichier nommé `file`. */
function upload(app: ReturnType<typeof uploadsRoutes>, id: string, bytes: Uint8Array, type: string, name = 'x.png') {
  const form = new FormData()
  form.append('file', new File([bytes], name, { type }))
  return app.request(`/projects/${id}/uploads`, { method: 'POST', body: form })
}

describe('POST /projects/:id/uploads', () => {
  test('PNG valide → 200 { path }, fichier écrit, .atelier/.gitignore créé', async () => {
    const { app, projectPath } = freshRoutes()
    const res = await upload(app, 'p1', new Uint8Array([1, 2, 3]), 'image/png')
    expect(res.status).toBe(200)
    const { path } = (await res.json()) as { path: string }
    expect(path).toMatch(/^\.atelier\/uploads\/[0-9a-f-]+\.png$/)
    expect(existsSync(join(projectPath, path))).toBe(true)
    expect(readFileSync(join(projectPath, '.atelier/.gitignore'), 'utf8')).toBe('*\n')
  })

  test('projet inconnu → 404', async () => {
    const { app } = freshRoutes(false)
    expect((await upload(app, 'nope', new Uint8Array([1]), 'image/png')).status).toBe(404)
  })

  test('MIME non supporté → 400', async () => {
    const { app } = freshRoutes()
    expect((await upload(app, 'p1', new Uint8Array([1]), 'application/pdf', 'x.pdf')).status).toBe(400)
  })

  test('taille > 10 Mo → 400', async () => {
    const { app } = freshRoutes()
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    expect((await upload(app, 'p1', big, 'image/png')).status).toBe(400)
  })

  test('champ file absent → 400', async () => {
    const { app } = freshRoutes()
    const res = await app.request('/projects/p1/uploads', { method: 'POST', body: new FormData() })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Vérifier l'échec** — `bun test apps/server/src/uploads/uploads-routes.test.ts` → FAIL (module introuvable).

- [ ] **Step 3: Implémenter**

```ts
// apps/server/src/uploads/uploads-routes.ts
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AppData } from '../store/app-data'
import { extensionForMime, MAX_IMAGE_BYTES } from './image-uploads'

/**
 * Upload d'image dans le dossier scratch du projet (spec 2026-08-13).
 * L'agent lira l'image via Read ; le chemin relatif retourné est inséré dans
 * le prompt côté composer. Résolution d'id inline (motif files-routes.ts).
 */
export function uploadsRoutes(data: AppData): Hono {
  const app = new Hono()

  app.post('/projects/:id/uploads', async (c) => {
    const project = data.get().projects.find((p) => p.id === c.req.param('id'))
    if (!project) return c.json({ error: 'Not found' }, 404)

    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File) || file.size === 0) return c.json({ error: 'Aucun fichier' }, 400)

    const ext = extensionForMime(file.type)
    if (ext === null) return c.json({ error: 'Type de fichier non supporté' }, 400)
    if (file.size > MAX_IMAGE_BYTES) return c.json({ error: 'Image trop volumineuse (max 10 Mo)' }, 400)

    const dir = join(project.path, '.atelier', 'uploads')
    await mkdir(dir, { recursive: true })
    // Auto-ignore : .atelier/.gitignore = "*" (créé une fois). `*` matche aussi
    // les dotfiles → tout .atelier/ est ignoré sans toucher le .gitignore racine.
    const ignore = join(project.path, '.atelier', '.gitignore')
    if (!existsSync(ignore)) await writeFile(ignore, '*\n')

    const name = `${randomUUID()}.${ext}`
    await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()))
    return c.json({ path: `.atelier/uploads/${name}` })
  })

  return app
}
```

- [ ] **Step 4: Vérifier le vert** — `bun test apps/server/src/uploads/uploads-routes.test.ts` → 5 pass.

- [ ] **Step 5: Monter dans app.ts + test d'app**

`import { uploadsRoutes } from './uploads/uploads-routes'` puis, après `api.route('/', filesRoutes(data))` :

```ts
api.route('/', uploadsRoutes(data))
```

Run: `bun test apps/server` → tout vert.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/uploads apps/server/src/app.ts
git commit -m "feat(server): endpoint POST /projects/:id/uploads (image → dossier scratch)"
```

## Chunk 2: Web (helper pur + API)

### Task 3: `insertMention` dans `file-mentions.ts`

**Files:**
- Modify: `apps/web/src/lib/file-mentions.ts`
- Modify: `apps/web/src/lib/file-mentions.test.ts`

- [ ] **Step 1: Tests qui échouent** — ajouter au `describe` de `file-mentions.test.ts` :

```ts
import { insertMention } from './file-mentions' // ajouter à l'import existant

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
```

Note de calcul (à respecter) : `insertMention('a b', 1, 'x.png')` → avant caret `'a'` (non-blanc) ⇒ espace de tête ; insert = `' @x.png '` (8 chars) ; texte = `'a' + ' @x.png ' + ' b'` = `'a @x.png  b'` ; caret = 1 + 8 = 9.

- [ ] **Step 2: Vérifier l'échec** — `bun test apps/web/src/lib/file-mentions.test.ts` → FAIL.

- [ ] **Step 3: Implémenter** — ajouter à `file-mentions.ts` :

```ts
/**
 * Insère une mention `@path` au caret pour un upload (aucun `@` préexistant,
 * contrairement à completeMention). Préfixe un espace si le caractère avant le
 * caret n'est ni un blanc ni le début — sinon `@` collé à un mot violerait la
 * règle « `@` précédé d'un blanc » de mentionPrefix. Suffixe : un espace.
 */
export function insertMention(text: string, caret: number, path: string): { text: string; caret: number } {
  const before = text.slice(0, caret)
  const needsSpace = before.length > 0 && !/\s$/.test(before)
  const inserted = `${needsSpace ? ' ' : ''}@${path} `
  return { text: before + inserted + text.slice(caret), caret: caret + inserted.length }
}
```

- [ ] **Step 4: Vérifier le vert** — `bun test apps/web/src/lib/file-mentions.test.ts` → tout vert.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/file-mentions.ts apps/web/src/lib/file-mentions.test.ts
git commit -m "feat(web): insertMention pour insérer une référence d'upload au caret"
```

### Task 4: Client API + Backend

**Files:**
- Modify: `apps/web/src/api/client.ts` (après `listFiles`)
- Modify: `apps/web/src/api/backend.ts` (type `Backend`, `realBackend`, fixture, `App.test.tsx` mock si besoin)

Pas de test dédié (motif du repo : `client.ts`/câblage RQ non testés ; couverture via Composer + serveur).

- [ ] **Step 1: `client.ts`** — le multipart ne passe pas par `request()` (JSON) :

```ts
/** Upload d'une image dans le projet (multipart) — répond { path } relatif. */
export async function uploadImage(projectId: string, file: File): Promise<{ path: string }> {
  const form = new FormData()
  form.append('file', file)
  // Pas de Content-Type manuel : le navigateur pose le boundary multipart.
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (!response.ok) {
    let detail: string | null = null
    try { detail = ((await response.json()) as { error?: string }).error ?? null } catch { /* non-JSON */ }
    throw new ApiError(response.status, detail ?? `POST /uploads → ${response.status}`)
  }
  return (await response.json()) as { path: string }
}
```

(`token` et `ApiError` sont déjà dans le module.)

- [ ] **Step 2: `backend.ts`** — type `Backend`, après une entrée existante :

```ts
  /** Upload d'une image dans le projet — l'agent la lit via Read. */
  uploadImage: (projectId: string, file: File) => Promise<{ path: string }>
```

`realBackend` : `uploadImage: client.uploadImage,`. Fixture (`createFixtureBackend`) :

```ts
    // Mode démo : pas d'écriture disque réelle.
    uploadImage: async () => ({ path: '.atelier/uploads/demo.png' }),
```

- [ ] **Step 3: Typecheck** — `bunx tsc --noEmit -p apps/web/tsconfig.json`. Le mock `fakeBackend: Backend` d'`App.test.tsx` **échouera** forcément sur le type élargi (propriété manquante) — c'est certain, pas conditionnel : ajouter `uploadImage: async () => ({ path: '.atelier/uploads/demo.png' })` au mock. `bun test apps/web` → vert (hors Composer, pas encore modifié).

**Ne PAS commit** — commit commun avec Task 5.

## Chunk 3: Composer

### Task 5: Trois entrées + insertion + état

**Files:**
- Modify: `apps/web/src/components/Composer.tsx`
- Modify: `apps/web/src/components/Composer.test.tsx`
- Modify: `apps/web/src/App.tsx` (prop `onUploadImage` fermée sur `projectId`)

- [ ] **Step 1: Tests qui échouent** — ajouter à `Composer.test.tsx`. `renderComposer` doit fournir `onUploadImage` par défaut (stub résolvant `{ path: '.atelier/uploads/x.png' }`) et le composer déjà présent reçoit la nouvelle prop.

```tsx
// Helper : fabrique un File image
const imageFile = (name = 'shot.png') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })

describe('upload d’image', () => {
  test('bouton parcourir : sélectionne un fichier → onUploadImage appelé, @path inséré', async () => {
    const calls: File[] = []
    renderComposer({ onUploadImage: async (f) => { calls.push(f); return { path: '.atelier/uploads/x.png' } } })
    const input = screen.getByLabelText('Ajouter une image') as HTMLInputElement // le <input file> ou son bouton
    // déclenche le change sur l'input caché
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [imageFile()] } })
    await screen.findByDisplayValue(/@\.atelier\/uploads\/x\.png/)
    expect(calls).toHaveLength(1)
  })

  test('coller une image : onUploadImage appelé, @path inséré', async () => {
    renderComposer()
    const ta = textarea()
    fireEvent.paste(ta, { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile() }], files: [imageFile()] } })
    await screen.findByDisplayValue(/@\.atelier\/uploads\/x\.png/)
  })

  test('glisser-déposer une image : onUploadImage appelé, @path inséré', async () => {
    const calls: File[] = []
    renderComposer({ onUploadImage: async (f) => { calls.push(f); return { path: '.atelier/uploads/x.png' } } })
    fireEvent.drop(textarea(), { dataTransfer: { files: [imageFile()] } })
    await screen.findByDisplayValue(/@\.atelier\/uploads\/x\.png/)
    expect(calls).toHaveLength(1)
  })

  test('échec d’upload : message inline, brouillon conservé', async () => {
    renderComposer({ onUploadImage: async () => { throw new Error('boom') } })
    fireEvent.change(textarea(), { target: { value: 'garde-moi', selectionStart: 9 } })
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [imageFile()] } })
    expect(await screen.findByText(/image/i)).toBeTruthy() // message d'erreur inline
    expect((textarea() as HTMLTextAreaElement).value).toBe('garde-moi')
  })

  test('upload concurrent bloqué : un second déclenchement pendant l’envoi est ignoré', async () => {
    let resolve!: (v: { path: string }) => void
    const calls: File[] = []
    renderComposer({ onUploadImage: (f) => { calls.push(f); return new Promise((r) => { resolve = r }) } })
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [imageFile()] } })
    fireEvent.change(fileInput, { target: { files: [imageFile('second.png')] } }) // ignoré (uploading)
    expect(calls).toHaveLength(1)
    resolve({ path: '.atelier/uploads/x.png' })
    await screen.findByDisplayValue(/@\.atelier\/uploads\/x\.png/)
  })
})
```

Note : ajuster les sélecteurs à l'implémentation réelle (label du bouton, texte d'erreur). L'important : couvrir parcourir + coller + erreur.

- [ ] **Step 2: Vérifier l'échec** — `bun test apps/web/src/components/Composer.test.tsx` → FAIL.

- [ ] **Step 3: Implémenter `Composer.tsx`**

1. Prop : ajouter à `ComposerProps` — `onUploadImage: (file: File) => Promise<{ path: string }>`.
2. Import : `import { insertMention } from '../lib/file-mentions'` (compléter l'import existant de `file-mentions`).
3. État : `const [uploading, setUploading] = useState(false)` et `const [uploadError, setUploadError] = useState<string | null>(null)` ; `const fileInputRef = useRef<HTMLInputElement>(null)`.
4. Handler central :

```ts
  const uploadFile = async (file: File) => {
    if (uploading) return
    setUploadError(null)
    setUploading(true)
    try {
      const { path } = await onUploadImage(file)
      // insère au caret courant (état `caret` déjà géré par le composer)
      const next = insertMention(text, caret, path)
      setText(next.text)
      setCaret(next.caret)
      setDismissed(true)
      textareaRef.current?.focus()
    } catch {
      setUploadError("Échec de l'envoi de l'image.")
    } finally {
      setUploading(false)
    }
  }
```

5. Entrées :
   - `onPaste` sur la textarea : parcourt `event.clipboardData?.items`, prend le premier `item.kind === 'file'` avec `item.type.startsWith('image/')`, `event.preventDefault()`, `uploadFile(item.getAsFile()!)`.
   - `onDragOver` : `event.preventDefault()` (autorise le drop) ; `onDrop` : `event.preventDefault()`, premier `event.dataTransfer.files` de type image → `uploadFile`.
   - Bouton image (dans la barre, à côté du bouton envoyer) `aria-label="Ajouter une image"` → `fileInputRef.current?.click()` ; `<input ref={fileInputRef} type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = '' }} />`.
6. Rendu : afficher `uploadError` en message inline sous la box (petit texte) quand non-null ; indicateur « Envoi de l'image… » quand `uploading`. Réinitialiser `uploadError` au prochain `onChange` de la textarea.

- [ ] **Step 4: `App.tsx`** — passer la prop, fermée sur le projet de la session :

```tsx
onUploadImage={(file) => backend.uploadImage(commandsProjectId ?? '', file)}
```

(sur le `<Composer …>`, à côté de `files={fileEntries}`.)

- [ ] **Step 5: Vérifier le vert** — `bun test apps/web` (Composer + non-régression slash/@/mentions). Ajuster sélecteurs de test si besoin.

- [ ] **Step 6: Typecheck complet** — `bunx tsc --noEmit -p apps/server/tsconfig.json && bunx tsc --noEmit -p apps/web/tsconfig.json` → vert.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/api/backend.ts apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/components/Composer.tsx apps/web/src/components/Composer.test.tsx
git commit -m "feat(web): upload d'image dans le composer (coller, glisser-déposer, parcourir)"
```

### Task 6: Vérification finale

- [ ] **Step 1: Suite complète** — `bun test` → tout vert.
- [ ] **Step 2: Rebuild web** (le serveur sert `apps/web/dist`) — `bun run build:web`. Rappel : toute modif frontend nécessite ce rebuild ; sinon l'app réelle sert l'ancien bundle (cf. incident @-mentions).
- [ ] **Step 3: Vérif manuelle** (voir MEMORY : port 4517 + jobs state.json avant de lancer quoi que ce soit). Coller une capture dans le composer → `@.atelier/uploads/…` inséré ; envoyer « décris @<image> » → l'agent Read l'image et la décrit.
