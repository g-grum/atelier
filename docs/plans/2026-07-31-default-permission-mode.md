# Mode de permissions par défaut — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une préférence globale `defaultPermissionMode` supprime le clic obligatoire sur le PermissionModeGate à chaque nouvelle session, capturée via une checkbox « Se souvenir » dans le gate et gérable depuis le SettingsPanel.

**Architecture:** Le serveur stampe le mode dans `createDraft` (seul point de naissance d'une session Atelier) quand la préférence est définie — jamais rétroactif. Le gate garde son test `permissionMode === null` inchangé. Spec normative : `docs/specs/2026-07-31-default-permission-mode-design.md`.

**Tech Stack:** Bun + Hono (apps/server), React 19 + TanStack Query + Testing Library (apps/web), types partagés dans packages/shared. Tests : `bun test`. TDD strict, un commit par tâche.

**Conventions repo:**
- Identité git locale g-grum (déjà configurée) — ne PAS commiter avec l'identité globale.
- bun ABSOLU pour les subagents : `/Users/demo/.bun/bin/bun` (PATH minimal).
- Guillemets français « » et apostrophes typographiques ’ dans les chaînes UI, mais quotes ASCII `'` dans le code — attention aux quotes typographiques accidentelles dans le code (leçon 2026-07-23).
- Ne PAS toucher au diff WIP en cours (`apps/web/src/lib/models.ts`, ajout Opus 5 dans `packages/shared/src/protocol.ts` ligne MODELS) — commits ciblés fichier par fichier (`git add <paths>` explicites, jamais `git add -A`).

---

## Chunk 1 : Serveur & contrat partagé

### Task 1: Contrat `Preferences.defaultPermissionMode` + défaut store

**Files:**
- Modify: `packages/shared/src/protocol.ts:32-43` (type `Preferences`)
- Modify: `apps/server/src/store/app-data.ts:28-47` (constante `EMPTY`)
- Test: `apps/server/src/app.test.ts` (section `// 8. GET/PATCH /api/preferences`, ~ligne 397)

- [ ] **Step 0: Mettre le WIP non lié de côté (non-interactif)**

`packages/shared/src/protocol.ts` porte un hunk WIP non lié (ajout `claude-opus-5` à `MODELS`, ligne 22). Le stasher AVANT de commencer, pour que les `git add` par chemin restent sûrs :

```bash
git stash push -m "wip opus-5 (hors périmètre plan permissions)" -- packages/shared/src/protocol.ts apps/web/src/lib/models.ts
```

(Les hunks WIP — `MODELS` ligne 22 et `MODEL_LABELS` — ne chevauchent pas les zones touchées par ce plan ; le `git stash pop` de la Task 7 se réappliquera sans conflit.)

- [ ] **Step 1: Écrire le test qui échoue**

Dans `apps/server/src/app.test.ts`, juste après le test `'GET /api/preferences returns defaults'` (~ligne 409), ajouter :

```ts
  test('GET /api/preferences exposes defaultPermissionMode null by default — the gate asks each session', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/preferences', {
      headers: { Authorization: 'Bearer test-token' },
    })
    const prefs = await res.json() as { defaultPermissionMode: 'default' | 'bypassPermissions' | null }
    expect(prefs.defaultPermissionMode).toBeNull()
  })
```

- [ ] **Step 2: Vérifier l'échec**

Run: `bun test apps/server/src/app.test.ts -t 'defaultPermissionMode null by default'`
Expected: FAIL — `undefined` reçu au lieu de `null` (la clé n'existe pas encore dans `EMPTY`).

- [ ] **Step 3: Implémenter le contrat + le défaut**

Dans `packages/shared/src/protocol.ts`, ajouter à la fin du type `Preferences` (après `theme?: Theme`) :

```ts
  /** Mode appliqué aux NOUVELLES sessions (stampé dans createDraft). Absent/null = demander à chaque session (gate). Jamais rétroactif. */
  defaultPermissionMode?: SessionPermissionMode | null
```

Note : `SessionPermissionMode` est déclaré plus bas dans le même fichier (~ligne 52) — les types TS n'exigent pas de déclaration avant usage, aucune réorganisation nécessaire.

Dans `apps/server/src/store/app-data.ts`, dans `EMPTY.preferences` (après `githubUser: 'alice-dev',`) :

```ts
    // Absent/null = le gate demande à chaque session (comportement historique, spec 2026-07-31).
    defaultPermissionMode: null,
```

Rétrocompat : le deep-merge par clé du constructeur (`preferences: { ...base.preferences, ...parsed.preferences }`, ligne 65) injecte ce défaut dans les `app-data.json` existants — aucun autre changement.

- [ ] **Step 4: Vérifier que le test passe**

Run: `bun test apps/server/src/app.test.ts -t 'defaultPermissionMode null by default'`
Expected: PASS

- [ ] **Step 5: Typecheck l'ensemble du monorepo**

Il n'existe PAS de script `typecheck`/`validate` — utiliser tsc directement (dispo dans `node_modules/.bin`, tsconfig par app, aucun à la racine ni dans packages/shared) :

Run: `bunx tsc --noEmit -p apps/server && bunx tsc --noEmit -p apps/web && bunx tsc --noEmit -p apps/desktop`
Expected: 0 erreur (le champ est optionnel — `DEFAULT_PREFERENCES` web et les fixtures existantes compilent sans modification).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/protocol.ts apps/server/src/store/app-data.ts apps/server/src/app.test.ts
git commit -m "feat(shared,server): préférence defaultPermissionMode (null = gate à chaque session)"
```

Vérifier avec `git show --stat HEAD` que seuls ces trois fichiers sont dans le commit (le WIP est au stash depuis le Step 0).

---

### Task 2: PATCH /api/preferences accepte `defaultPermissionMode`

**Files:**
- Modify: `apps/server/src/routes/settings-routes.ts:60-98` (handler PATCH)
- Test: `apps/server/src/app.test.ts` (même section)

- [ ] **Step 1: Écrire les trois tests qui échouent**

Dans `apps/server/src/app.test.ts`, après le test ajouté en Task 1 :

```ts
  test('PATCH /api/preferences persists defaultPermissionMode and survives a reload', async () => {
    const { app, filePath } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    const rp = await app.request('/api/preferences', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ defaultPermissionMode: 'bypassPermissions' }),
    })
    expect(rp.status).toBe(200)
    const prefs = await rp.json() as { defaultPermissionMode: string | null }
    expect(prefs.defaultPermissionMode).toBe('bypassPermissions')

    const reloaded = new AppData(filePath)
    expect(reloaded.get().preferences.defaultPermissionMode).toBe('bypassPermissions')
  })

  test('PATCH /api/preferences with defaultPermissionMode null CLEARS a set value (undefined-vs-null trap)', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    await app.request('/api/preferences', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ defaultPermissionMode: 'default' }),
    })
    // Assertion intermédiaire : sans elle, le test passerait PAR VACUITÉ avant
    // l'implémentation (deux PATCH ignorés → la valeur reste null → toBeNull vert).
    const rg1 = await app.request('/api/preferences', { headers: auth })
    expect(((await rg1.json()) as { defaultPermissionMode: string | null }).defaultPermissionMode).toBe('default')

    const rp = await app.request('/api/preferences', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ defaultPermissionMode: null }),
    })
    expect(rp.status).toBe(200)
    const prefs = await rp.json() as { defaultPermissionMode: string | null }
    expect(prefs.defaultPermissionMode).toBeNull()
  })

  test('PATCH /api/preferences rejects an unknown defaultPermissionMode with 400 and leaves preferences untouched', async () => {
    const { app } = freshApp()
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

    for (const value of ['yolo', 42, true, {}] as const) {
      const res = await app.request('/api/preferences', {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ defaultPermissionMode: value }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(typeof body.error).toBe('string')
    }
    const rg = await app.request('/api/preferences', { headers: auth })
    const prefs = await rg.json() as { defaultPermissionMode: string | null }
    expect(prefs.defaultPermissionMode).toBeNull()
  })
```

- [ ] **Step 2: Vérifier l'échec**

Run: `bun test apps/server/src/app.test.ts -t 'defaultPermissionMode'`
Expected: le test Task 1 PASS ; les trois nouveaux FAIL — le PATCH ignore le champ, donc : test 1 reçoit `null`, test 2 échoue sur l'assertion intermédiaire (`'default'` attendu, `null` reçu), test 3 reçoit 200 au lieu de 400.

- [ ] **Step 3: Implémenter la validation + l'écriture**

Dans `apps/server/src/routes/settings-routes.ts` :

1. Étendre l'import shared (ligne 3) :

```ts
import { SESSION_PERMISSION_MODES, THEMES, type ProjectSummary, type SessionPermissionMode, type Theme } from '@atelier/shared'
```

2. Après le guard `theme` (~ligne 75), ajouter :

```ts
    // null = effacer (le gate revient) ; sinon un des SESSION_PERMISSION_MODES. Le pattern
    // `!== undefined` du bloc d'écriture rend le null explicite indispensable (spec 2026-07-31).
    if (
      parsed.defaultPermissionMode !== undefined &&
      parsed.defaultPermissionMode !== null &&
      !SESSION_PERMISSION_MODES.includes(parsed.defaultPermissionMode as SessionPermissionMode)
    ) {
      return c.json({ error: 'requête invalide : « defaultPermissionMode » doit être « default », « bypassPermissions » ou null' }, 400)
    }
```

3. Dans le bloc `data.update((d) => { … })` (~ligne 89), après la ligne `theme` :

```ts
      if (parsed.defaultPermissionMode !== undefined) {
        d.preferences.defaultPermissionMode = parsed.defaultPermissionMode as SessionPermissionMode | null
      }
```

- [ ] **Step 4: Vérifier que tout passe**

Run: `bun test apps/server/src/app.test.ts`
Expected: PASS (tous, y compris les tests body-guard existants — `null`/`[]` en corps brut restent des 400 via `readJsonObject`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/settings-routes.ts apps/server/src/app.test.ts
git commit -m "feat(server): PATCH /preferences valide et persiste defaultPermissionMode (null efface)"
```

---

### Task 3: `createDraft` stampe le défaut

**Files:**
- Modify: `apps/server/src/sessions/sessions-service.ts:70-90` (méthode `createDraft`)
- Test: `apps/server/src/sessions/sessions-service.test.ts`

- [ ] **Step 1: Écrire les deux tests qui échouent**

Dans `apps/server/src/sessions/sessions-service.test.ts`, après le test `'createDraft returns permissionMode null — the UI must ask before the first turn'` (~ligne 91) :

```ts
  test('createDraft stamps preferences.defaultPermissionMode — no gate for the new session', async () => {
    const { service, data } = freshSetup()
    data.update((d) => {
      d.preferences.defaultPermissionMode = 'bypassPermissions'
    })

    const summary = service.createDraft('p1', {})

    // Le SessionSummary retourné ET le record stocké portent le mode (cohérence spec).
    expect(summary.permissionMode).toBe('bypassPermissions')
    const result = await service.list('p1')
    expect(result[0]?.permissionMode).toBe('bypassPermissions')
  })

  test('a stamped draft keeps its mode through materialization (mapDraft)', () => {
    const { service, data } = freshSetup()
    data.update((d) => {
      d.preferences.defaultPermissionMode = 'default'
    })
    const draft = service.createDraft('p1', {})

    data.mapDraft(draft.id, 'sdk-1')

    expect(data.get().permissionModes['sdk-1']).toBe('default')
  })
```

- [ ] **Step 2: Vérifier l'échec**

Run: `bun test apps/server/src/sessions/sessions-service.test.ts -t 'stamp'`
Expected: FAIL ×2 — premier test : `null` reçu (createDraft code le mode en dur) ; second test : `undefined` reçu (`permissionModes['sdk-1']` absent — mapDraft saute les modes null).

- [ ] **Step 3: Implémenter le stamping**

Dans `apps/server/src/sessions/sessions-service.ts`, remplacer `createDraft` (lignes 70-90) par :

```ts
  createDraft(projectId: string, { name, model }: { name?: string; model?: string }): SessionSummary {
    const { preferences } = this.data.get()
    const id = randomUUID()
    const resolvedModel = model ?? preferences.defaultModel
    // Défaut global stampé à la naissance (spec 2026-07-31) — null = le gate demandera.
    // Les DEUX null codés en dur (record stocké + summary retourné) passent par cette valeur.
    const permissionMode = preferences.defaultPermissionMode ?? null
    const createdAt = new Date().toISOString()

    this.data.update((d) => {
      d.drafts.push({ id, projectId, name: name ?? null, model: resolvedModel, createdAt, permissionMode })
    })

    return {
      id,
      projectId,
      name: name ?? null,
      updatedAt: createdAt,
      messageCount: 0,
      isDraft: true,
      model: resolvedModel,
      permissionMode,
    }
  }
```

- [ ] **Step 4: Vérifier que tout passe**

Run: `bun test apps/server/src/sessions/sessions-service.test.ts`
Expected: PASS — y compris le test existant `'createDraft returns permissionMode null …'` (défaut absent → `?? null`).

- [ ] **Step 5: Lancer toute la suite serveur**

Run: `bun test apps/server`
Expected: PASS (le stream, le broker et `session-stream.ts:114` ne changent pas).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/sessions/sessions-service.ts apps/server/src/sessions/sessions-service.test.ts
git commit -m "feat(server): createDraft stampe defaultPermissionMode — plus de gate quand un défaut est défini"
```

---

## Chunk 2 : Web

### Task 4: Gate — checkbox « Se souvenir de ce choix »

**Files:**
- Modify: `apps/web/src/components/PermissionModeGate.tsx`
- Modify: `apps/web/src/App.tsx:273-279` (mutations) et `:406-413` (rendu du gate)
- Modify: `apps/web/src/styles.css:328-335` (bloc `.perm-gate`)
- Test: `apps/web/src/App.test.tsx` (describe `'App per-session permissions gate'`, ~ligne 165)

- [ ] **Step 1: Écrire les deux tests qui échouent**

Dans `apps/web/src/App.test.tsx`, à la fin du describe `'App per-session permissions gate'` (avant sa fermeture ~ligne 210) :

```ts
  test('checking « Se souvenir » patches the session AND the preference default', async () => {
    let mode: SessionSummary['permissionMode'] = null
    const prefPatches: unknown[] = []
    const backend = fakeBackend({
      listSessions: async () => [{ ...session, permissionMode: mode }],
      patchSession: async (_id, patch) => {
        if (patch.permissionMode !== undefined) mode = patch.permissionMode
      },
      patchPreferences: async (patch) => {
        prefPatches.push(patch)
        return { ...DEFAULT_PREFERENCES, ...patch }
      },
    })
    renderApp(backend)

    fireEvent.click(await screen.findByLabelText(/Se souvenir de ce choix/))
    fireEvent.click(screen.getByRole('button', { name: /dangereux/i }))

    await waitFor(() => expect(prefPatches).toEqual([{ defaultPermissionMode: 'bypassPermissions' }]))
  })

  test('choosing WITHOUT the checkbox never patches the preferences', async () => {
    let mode: SessionSummary['permissionMode'] = null
    const prefPatches: unknown[] = []
    const backend = fakeBackend({
      listSessions: async () => [{ ...session, permissionMode: mode }],
      patchSession: async (_id, patch) => {
        if (patch.permissionMode !== undefined) mode = patch.permissionMode
      },
      patchPreferences: async (patch) => {
        prefPatches.push(patch)
        return { ...DEFAULT_PREFERENCES, ...patch }
      },
    })
    renderApp(backend)

    fireEvent.click(await screen.findByRole('button', { name: 'Permissions normales' }))

    await waitFor(() => expect((screen.getByLabelText('Répondre à Claude') as HTMLTextAreaElement).disabled).toBe(false))
    expect(prefPatches).toEqual([])
  })
```

Note : `DEFAULT_PREFERENCES` est déjà importé en tête de fichier (ligne 6). Le premier test échoue sur `findByLabelText(/Se souvenir/)` tant que la checkbox n'existe pas. Le second passe déjà avant l'implémentation (rien ne patche les préférences aujourd'hui) : c'est le garde-fou de non-régression, ne pas s'étonner qu'il soit vert au Step 2.

- [ ] **Step 2: Vérifier l'échec**

Run: `bun test apps/web/src/App.test.tsx -t 'Se souvenir'`
Expected: FAIL — « Unable to find a label with the text of: /Se souvenir de ce choix/ ».

- [ ] **Step 3: Implémenter la checkbox dans le gate**

Remplacer intégralement `apps/web/src/components/PermissionModeGate.tsx` par :

```tsx
import { useState } from 'react'
import type { SessionPermissionMode } from '@atelier/shared'

export type PermissionModeGateProps = {
  /** Persists the choice (PATCH /sessions/:id) — the gate stays until the refetched session carries it. `remember` demande EN PLUS d'enregistrer le mode comme défaut global (PATCH /preferences, indépendant). */
  onChoose: (mode: SessionPermissionMode, remember: boolean) => void
  /** Patch in flight — both buttons lock to avoid a double answer. */
  pending: boolean
}

/**
 * Per-session permissions question. Rendered above the composer while the
 * active session's permissionMode is null; the composer stays disabled until
 * an answer lands. The dangerous choice is red (never amber — that is
 * reserved for tool permissions). Depuis la spec 2026-07-31, « Se souvenir »
 * enregistre le choix comme défaut global : les prochaines sessions naissent
 * stampées et ne montrent plus le gate (révocable dans les réglages).
 */
export function PermissionModeGate({ onChoose, pending }: PermissionModeGateProps) {
  const [remember, setRemember] = useState(false)
  return (
    <div className="perm-gate" role="group" aria-label="Permissions de la session">
      <span className="perm-gate-text">Comment gérer les permissions d’outils pour cette session ?</span>
      <div className="perm-gate-actions">
        <button type="button" className="perm-gate-btn" disabled={pending} onClick={() => onChoose('default', remember)}>
          Permissions normales
        </button>
        <button type="button" className="perm-gate-btn danger" disabled={pending} onClick={() => onChoose('bypassPermissions', remember)}>
          Skip permissions (dangereux)
        </button>
      </div>
      <label className="perm-gate-remember">
        <input
          type="checkbox"
          checked={remember}
          disabled={pending}
          onChange={(event) => setRemember(event.target.checked)}
        />
        Se souvenir de ce choix pour les nouvelles sessions (modifiable dans les réglages)
      </label>
    </div>
  )
}
```

- [ ] **Step 4: Câbler App.tsx**

Dans `apps/web/src/App.tsx`, après la mutation `setPermissionMode` (~ligne 279), ajouter :

```tsx
  // « Se souvenir » du gate — PATCH préférences indépendant du PATCH session :
  // si l'un échoue l'autre tient (spec 2026-07-31, gestion d'erreurs).
  const rememberPermissionDefault = useMutation({
    mutationFn: (mode: SessionPermissionMode) => backend.patchPreferences({ defaultPermissionMode: mode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['preferences'] }),
    onError: (error) => setNotice(`Impossible d’enregistrer le défaut de permissions : ${errorMessage(error)}`),
  })
```

Et remplacer le rendu du gate (~lignes 406-413) par :

```tsx
          {needsPermissionChoice && (
            <PermissionModeGate
              pending={setPermissionMode.isPending}
              onChoose={(mode, remember) => {
                if (selected !== null) setPermissionMode.mutate({ sessionId: selected.sessionId, mode })
                if (remember) rememberPermissionDefault.mutate(mode)
              }}
            />
          )}
```

- [ ] **Step 5: Styler la checkbox**

Dans `apps/web/src/styles.css`, après la ligne `.perm-gate .perm-gate-btn:disabled …` (ligne 335) :

```css
  .perm-gate .perm-gate-remember { flex-basis: 100%; display: flex; align-items: center; gap: 6px; color: var(--color-faint); font-size: 11.5px; cursor: pointer; }
  .perm-gate .perm-gate-remember input { accent-color: var(--color-indigo); cursor: pointer; }
```

(`.perm-gate` est déjà en `flex-wrap: wrap` — le `flex-basis: 100%` pose la checkbox sur sa propre ligne.)

- [ ] **Step 6: Vérifier que tout passe**

Run: `bun test apps/web/src/App.test.tsx`
Expected: PASS — les deux nouveaux tests ET les trois tests gate existants (leur `onChoose` ne cochant jamais la checkbox, aucun PATCH préférences ne part).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/PermissionModeGate.tsx apps/web/src/App.tsx apps/web/src/styles.css apps/web/src/App.test.tsx
git commit -m "feat(web): checkbox « Se souvenir » dans le gate — enregistre le défaut global de permissions"
```

---

### Task 5: SettingsPanel — section « Permissions des nouvelles sessions »

**Files:**
- Modify: `apps/web/src/components/SettingsPanel.tsx` (nouvelle section entre « Thème » ~ligne 221 et « Règles » ~ligne 223)
- Test: `apps/web/src/components/SettingsPanel.test.tsx`

- [ ] **Step 1: Écrire le test qui échoue**

Dans `apps/web/src/components/SettingsPanel.test.tsx`, dans le describe `'SettingsPanel'` :

```ts
  test('the permissions select shows the current default and PATCHes changes — null clears', async () => {
    const calls = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Réglages' }))

    const select = (await screen.findByLabelText('Permissions des nouvelles sessions')) as HTMLSelectElement
    // preferences fixture sans defaultPermissionMode → « demander à chaque session »
    expect(select.value).toBe('')

    fireEvent.change(select, { target: { value: 'bypassPermissions' } })
    await waitFor(() => expect(calls.patches).toEqual([{ defaultPermissionMode: 'bypassPermissions' }]))

    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() =>
      expect(calls.patches).toEqual([{ defaultPermissionMode: 'bypassPermissions' }, { defaultPermissionMode: null }]),
    )
  })
```

- [ ] **Step 2: Vérifier l'échec**

Run: `bun test apps/web/src/components/SettingsPanel.test.tsx -t 'permissions select'`
Expected: FAIL — « Unable to find a label with the text of: Permissions des nouvelles sessions ».

- [ ] **Step 3: Implémenter la section**

Dans `apps/web/src/components/SettingsPanel.tsx` :

1. Étendre l'import shared (ligne 4) :

```tsx
import { MODELS, type AlwaysRule, type Preferences, type ProjectSummary, type SessionPermissionMode, type Theme } from '@atelier/shared'
```

2. Insérer la section entre « Thème » (fin ~ligne 221) et « Règles "toujours autoriser" » (~ligne 223) :

```tsx
      <section className="flex flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="settings-permissions">
          Permissions des nouvelles sessions
        </label>
        {prefsQuery.isPending ? (
          <p className={HINT_CLASS}>Chargement…</p>
        ) : prefs === undefined ? null : (
          <select
            id="settings-permissions"
            // Le skip est un état dangereux : la valeur sélectionnée s'affiche en rouge
            // (l'ambre reste réservé aux prompts de permissions — charte).
            className={`${SELECT_CLASS}${prefs.defaultPermissionMode === 'bypassPermissions' ? ' text-red' : ''}`}
            value={prefs.defaultPermissionMode ?? ''}
            disabled={patchPrefs.isPending}
            onChange={(event) =>
              patchPrefs.mutate({
                defaultPermissionMode: event.target.value === '' ? null : (event.target.value as SessionPermissionMode),
              })
            }
          >
            <option value="">Demander à chaque session</option>
            <option value="default">Permissions normales</option>
            <option value="bypassPermissions">Skip permissions (dangereux)</option>
          </select>
        )}
        <p className={HINT_CLASS}>Appliqué aux nouvelles sessions uniquement — les sessions existantes gardent leur mode.</p>
      </section>
```

- [ ] **Step 4: Vérifier que tout passe**

Run: `bun test apps/web/src/components/SettingsPanel.test.tsx`
Expected: PASS (la fixture `preferences` du fichier n'a pas le champ — optionnel, aucun autre test à toucher).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SettingsPanel.tsx apps/web/src/components/SettingsPanel.test.tsx
git commit -m "feat(web): réglage « Permissions des nouvelles sessions » (demander / normales / skip)"
```

---

### Task 6: Puce « Skip permissions » près du composer

**Files:**
- Modify: `apps/web/src/App.tsx` (juste avant `<Composer …` ~ligne 414)
- Modify: `apps/web/src/styles.css` (après le bloc `.perm-gate`)
- Test: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Écrire les deux tests qui échouent**

Dans `apps/web/src/App.test.tsx`, nouveau describe après `'App per-session permissions gate'` :

```ts
describe('App bypass indicator', () => {
  test('a bypassPermissions session shows the red chip near the composer', async () => {
    renderApp(fakeBackend({ listSessions: async () => [{ ...session, permissionMode: 'bypassPermissions' }] }))
    // findByText EXACT (pas findByRole('status') : dnd-kit monte déjà une LiveRegion
    // role="status" via DashboardGrid — la requête par rôle matcherait deux éléments).
    // Le match exact ne touche pas le bouton du gate « Skip permissions (dangereux) »,
    // qui de toute façon ne se rend pas pour une session décidée.
    const chip = await screen.findByText('Skip permissions')
    expect(chip.title).toContain('le défaut se gère dans les réglages')
  })

  test('a default-mode session shows no chip', async () => {
    renderApp(fakeBackend())
    await waitFor(() => expect((screen.getByLabelText('Répondre à Claude') as HTMLTextAreaElement).disabled).toBe(false))
    expect(screen.queryByText('Skip permissions')).toBeNull()
  })
})
```

- [ ] **Step 2: Vérifier l'échec**

Run: `bun test apps/web/src/App.test.tsx -t 'bypass indicator'`
Expected: FAIL ×1 (premier test) — « Unable to find an element with the text: Skip permissions » ; le second passe déjà (rien à afficher) : c'est le garde-fou de non-régression.

- [ ] **Step 3: Implémenter la puce**

Dans `apps/web/src/App.tsx`, juste avant `<Composer` (~ligne 414) :

```tsx
          {activeSession?.permissionMode === 'bypassPermissions' && (
            <div
              className="perm-bypass-chip"
              role="status"
              title="Défini pour cette session — le défaut se gère dans les réglages"
            >
              Skip permissions
            </div>
          )}
```

Dans `apps/web/src/styles.css`, après les règles `.perm-gate-remember` (Task 4) :

```css
  /* Rappel discret qu'une session tourne SANS garde-fou — rouge (état dangereux), jamais ambre. */
  .perm-bypass-chip { align-self: flex-start; margin: 8px 28px 0; padding: 2px 9px; font: 700 10px var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-red); border: 1px solid color-mix(in srgb, var(--color-red) 40%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--color-red) 8%, transparent); }
```

- [ ] **Step 4: Vérifier que tout passe**

Run: `bun test apps/web/src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/styles.css apps/web/src/App.test.tsx
git commit -m "feat(web): puce rouge « Skip permissions » quand la session active bypasse les permissions"
```

---

### Task 7: Gates finaux + release

- [ ] **Step 1: Suite complète + typecheck**

Il n'existe PAS de script `validate` ni de biome dans ce repo — les gates réels sont :

Run: `bun test && bunx tsc --noEmit -p apps/server && bunx tsc --noEmit -p apps/web && bunx tsc --noEmit -p apps/desktop`
Expected: 0 erreur (~430+ tests verts, 3 typechecks propres).

- [ ] **Step 2: Bump version + notes**

Dans `version.json` (racine), incrémenter le patch et remplacer les notes (FR concises, style existant) :

```json
{
  "version": "<version courante +0.0.1>",
  "notes": [
    "Le choix de permissions peut être mémorisé : cochez « Se souvenir » dans le gate ou réglez-le dans Réglages → Permissions des nouvelles sessions.",
    "Une puce rouge rappelle quand une session tourne en skip permissions."
  ]
}
```

- [ ] **Step 3: Build web (déploiement 2ᵉ étage)**

Run: `bun run build:web`
Expected: build OK — l'app en cours toaste « Une nouvelle version est disponible » ; ⌘R suffit (aucun changement desktop/main.ts → pas de `package:mac`).

- [ ] **Step 4: Commit final**

```bash
git add version.json
git commit -m "release: <version> — mode de permissions par défaut"
```

- [x] **Step 4bis: Restaurer le WIP stashé — DÉJÀ FAIT (coordination sessions parallèles)**

Le WIP opus-5 appartient à une session jumelle active (feature slash-commands/QCM). Le stash a été restauré immédiatement après la Task 1 pour ne pas perturber son travail — plus aucune tâche de ce plan ne touche `protocol.ts`/`models.ts`. Conséquence assumée : le `build:web` du Step 3 embarquera ce WIP non commité (comportement pré-existant, sans impact sur cette feature).

- [ ] **Step 5: Vérification end-to-end**

Avant de démarrer quoi que ce soit : `lsof -nP -iTCP:4517 -sTCP:LISTEN` — si un serveur écoute, identifier son propriétaire (`ps -p <pid> -o lstart,command`) et NE PAS le tuer s'il appartient à une session vivante ; utiliser `ATELIER_PORT=4519` pour tester à côté. Puis : créer une session → cocher « Se souvenir » + « Skip permissions » → vérifier que la session suivante ne montre PAS le gate et porte la puce rouge → Réglages → vérifier visuellement que la valeur « Skip permissions (dangereux) » du select s'affiche en ROUGE (deux utilitaires text-* concurrents, l'ordre CSS généré décide — non couvert par les tests) → repasser sur « Demander à chaque session » → la session suivante remontre le gate.
