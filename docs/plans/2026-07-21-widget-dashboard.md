# Widget Dashboard & GitHub PRs Widget Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Atelier's static right column into a drag & drop widget dashboard (persisted layout) and add a multi-instance GitHub Pull Requests widget backed by a server-side `gh` CLI proxy.

**Architecture:** Shared contracts in `packages/shared`; layout persisted in `AppData` behind `GET/PUT /api/widgets`; `DashboardGrid` (dnd-kit sortable + CSS grid) owns layout/chrome while `App` keeps owning data via a `renderWidget` injection; a `GithubService` (injectable `GhRunner` seam, 60 s cache, account-pinned token) feeds `GET /api/github/prs`.

**Tech Stack:** React 19, @dnd-kit/core + @dnd-kit/sortable (new), Radix, react-query 5, Hono on Bun, `gh` CLI.

**Spec:** `docs/specs/2026-07-21-widget-dashboard-design.md` (approved). Read it before starting.

**House rules:** work directly on `main` (owner's process), TDD, frequent commits, French user-facing strings, never-500 body-guard convention on routes. Test command: `bun test` (repo root) or `bun test <path>` for one file. **Before starting any server on port 4517, follow the parallel-jobs check** (lsof + `~/.claude/jobs/*/state.json`) — another session may own it.

---

## Chunk 1: Contracts & server persistence

### Task 1: Shared widget contracts

**Files:**
- Modify: `packages/shared/src/protocol.ts` (append at end)
- Test: `packages/shared/src/protocol.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/protocol.test.ts`:

```ts
import { DEFAULT_WIDGETS, REPO_PATTERN } from './protocol'

describe('widget contracts', () => {
  test('DEFAULT_WIDGETS mirrors the current aside: rate-limits then modified-files, full width, height M', () => {
    expect(DEFAULT_WIDGETS.map((w) => w.type)).toEqual(['rate-limits', 'modified-files'])
    for (const w of DEFAULT_WIDGETS) {
      expect(w.span).toBe(2)
      expect(w.height).toBe('M')
      expect(w.config).toBeUndefined()
    }
  })

  test('REPO_PATTERN accepts owner/repo and rejects everything else', () => {
    expect(REPO_PATTERN.test('acme-corp/demoapp-frontend')).toBe(true)
    expect(REPO_PATTERN.test('a.b-c_d/e.f-g_h')).toBe(true)
    expect(REPO_PATTERN.test('no-slash')).toBe(false)
    expect(REPO_PATTERN.test('a/b/c')).toBe(false)
    expect(REPO_PATTERN.test('owner/repo?x=1')).toBe(false)
  })
})
```

(Reuse the existing `describe/test/expect` imports of the file — check its header first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/protocol.test.ts`
Expected: FAIL — `DEFAULT_WIDGETS` not exported.

- [ ] **Step 3: Implement**

Append to `packages/shared/src/protocol.ts`:

```ts
// ── Widget dashboard (spec 2026-07-21) ──
export type WidgetType = 'github-prs' | 'rate-limits' | 'modified-files'
export type WidgetHeight = 'S' | 'M' | 'L'
export type WidgetInstance = {
  /** uuid, unique in the array (array order = display order) */
  id: string
  type: WidgetType
  /** grid columns occupied (the dash grid has 2 columns) */
  span: 1 | 2
  /** fixed height tier — content scrolls internally */
  height: WidgetHeight
  /** github-prs: REQUIRED (repo); other types: must be absent (PUT validation enforces both) */
  config?: { repo: string; limit?: number }
}

/** Types that may appear at most once in a layout. */
export const SINGLETON_WIDGET_TYPES: readonly WidgetType[] = ['rate-limits', 'modified-files']

/** owner/repo — shared by PUT /api/widgets, GET /api/github/prs and the config dialog. Anchored: no slashes inside segments, no query strings. */
export const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/

/**
 * Single source for the server default AND the web fallback (spec: they must
 * not drift). Mirrors the pre-dashboard aside. NEVER mutate — consumers clone.
 */
export const DEFAULT_WIDGETS: readonly WidgetInstance[] = [
  { id: 'default-rate-limits', type: 'rate-limits', span: 2, height: 'M' },
  { id: 'default-modified-files', type: 'modified-files', span: 2, height: 'M' },
]

// ── GitHub PRs (spec 2026-07-21) ──
export type PrState = 'open' | 'merged' | 'closed' | 'draft'
export type PrCi = 'passed' | 'failed' | 'pending' | null
export type PrReview = 'approved' | 'changes_requested' | 'required' | null
/** REST shape of GET /api/github/prs — one entry per PR, newest activity first. */
export type PrSummary = {
  number: number
  title: string
  url: string
  author: string
  state: PrState
  updatedAt: string
  branch: string
  ci: PrCi
  review: PrReview
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/protocol.test.ts`
Expected: PASS (all pre-existing tests too).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/protocol.test.ts
git commit -m "feat(shared): widget dashboard + PR summary contracts"
```

### Task 2: Persist `widgets` in AppData

**Files:**
- Modify: `apps/server/src/store/app-data.ts`
- Test: `apps/server/src/store/app-data.test.ts` (create — the store has no dedicated test file yet)

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/store/app-data.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_WIDGETS } from '@atelier/shared'
import { AppData } from './app-data'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'atelier-appdata-')), 'data.json')
}

describe('AppData.widgets', () => {
  test('fresh store defaults to DEFAULT_WIDGETS', () => {
    const data = new AppData(tmpFile())
    expect(data.get().widgets).toEqual([...DEFAULT_WIDGETS])
  })

  test('legacy file without the key gets the default (backward compat)', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ projects: [] }))
    const data = new AppData(file)
    expect(data.get().widgets).toEqual([...DEFAULT_WIDGETS])
  })

  test('legacy-file instance mutating IN PLACE never pollutes another instance (clone guard)', () => {
    // Both instances must take the `{ ...EMPTY, ...parsed }` branch (file WITHOUT
    // the key) and the mutation must be in-place — a replaced reference or the
    // fresh-store branch would pass even without the clone guard.
    const legacyA = tmpFile()
    writeFileSync(legacyA, JSON.stringify({ projects: [] }))
    new AppData(legacyA).update((d) => {
      d.widgets.push({ id: 'x', type: 'github-prs', span: 1, height: 'S', config: { repo: 'o/r' } })
    })
    const legacyB = tmpFile()
    writeFileSync(legacyB, JSON.stringify({ projects: [] }))
    expect(new AppData(legacyB).get().widgets).toEqual([...DEFAULT_WIDGETS])
  })

  test('a stored layout round-trips through the file', () => {
    const file = tmpFile()
    const stored = [{ id: 'w1', type: 'github-prs', span: 1, height: 'S', config: { repo: 'o/r', limit: 5 } }]
    new AppData(file).update((d) => {
      d.widgets = stored as typeof d.widgets
    })
    expect(new AppData(file).get().widgets).toEqual(stored as never)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/store/app-data.test.ts`
Expected: FAIL — `widgets` missing on `AppDataShape`.

- [ ] **Step 3: Implement**

In `apps/server/src/store/app-data.ts`:

1. Import: add `WidgetInstance` and `DEFAULT_WIDGETS` to the `@atelier/shared` import (note: `DEFAULT_WIDGETS` is a value — import it outside `import type`).
2. Add to `AppDataShape`:

```ts
  /** Dashboard layout — array order = display order. Spec 2026-07-21. */
  widgets: WidgetInstance[]
```

3. Add to `EMPTY`: `widgets: [...DEFAULT_WIDGETS],`
4. **Clone guard** — the constructor's `{ ...EMPTY, ...parsed }` would alias `EMPTY.widgets` when the file lacks the key, and a later `update()` mutation would poison every future instance. Change the constructor's assignment to:

```ts
      this.data = {
        ...EMPTY,
        ...parsed,
        preferences: { ...EMPTY.preferences, ...parsed.preferences },
        // Same aliasing trap as preferences, but for an array: a legacy file
        // without `widgets` must get a FRESH copy of the default, never a
        // reference into EMPTY (one instance's mutation would pollute all).
        widgets: parsed.widgets ?? structuredClone(EMPTY.widgets),
      }
```

(The `else` branch already uses `structuredClone(EMPTY)` — nothing to do there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/store/app-data.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole server suite (the shape changed)**

Run: `bun test apps/server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/store/app-data.ts apps/server/src/store/app-data.test.ts
git commit -m "feat(server): persist dashboard widgets in AppData (safe defaults)"
```

### Task 3: Widget layout validation module

**Files:**
- Create: `apps/server/src/routes/validate-widgets.ts`
- Test: `apps/server/src/routes/validate-widgets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/routes/validate-widgets.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { validateWidgets } from './validate-widgets'

const ok = (over: object = {}) => ({ id: 'a', type: 'rate-limits', span: 2, height: 'M', ...over })
const pr = (over: object = {}) => ({ id: 'p', type: 'github-prs', span: 2, height: 'M', config: { repo: 'o/r' }, ...over })

describe('validateWidgets', () => {
  test('accepts a valid layout and strips unknown keys', () => {
    const result = validateWidgets([{ ...ok(), rogue: true }, pr({ id: 'p1', config: { repo: 'o/r', limit: 5 } })])
    if ('error' in result) throw new Error(result.error)
    expect(result.widgets).toEqual([
      { id: 'a', type: 'rate-limits', span: 2, height: 'M' },
      { id: 'p1', type: 'github-prs', span: 2, height: 'M', config: { repo: 'o/r', limit: 5 } },
    ])
  })

  test('accepts the empty layout', () => {
    expect(validateWidgets([])).toEqual({ widgets: [] })
  })

  test.each([
    ['not an array', {}, 'tableau'],
    ['non-object entry', [42], 'objet'],
    ['missing id', [ok({ id: undefined })], 'id'],
    ['duplicate id', [ok(), ok()], 'dupliqué'],
    ['unknown type', [ok({ type: 'clock' })], 'type inconnu'],
    ['bad span', [ok({ span: 3 })], 'span'],
    ['bad height', [ok({ height: 'XL' })], 'height'],
    ['github-prs without config', [pr({ config: undefined })], 'config'],
    ['github-prs bad repo', [pr({ config: { repo: 'no-slash' } })], 'repo'],
    ['github-prs bad limit', [pr({ config: { repo: 'o/r', limit: 0 } })], 'limit'],
    ['config on a singleton', [ok({ config: { repo: 'o/r' } })], 'config'],
    ['duplicate singleton', [ok(), ok({ id: 'b' })], 'une fois'],
  ] as const)('rejects %s', (_name, value, fragment) => {
    const result = validateWidgets(value)
    if (!('error' in result)) throw new Error('expected an error')
    expect(result.error).toContain(fragment)
  })

  test('multiple github-prs instances are allowed', () => {
    const result = validateWidgets([pr({ id: 'p1' }), pr({ id: 'p2' })])
    expect('error' in result).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/routes/validate-widgets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/server/src/routes/validate-widgets.ts`:

```ts
import { REPO_PATTERN, SINGLETON_WIDGET_TYPES, type WidgetInstance, type WidgetType } from '@atelier/shared'

const TYPES: ReadonlySet<string> = new Set<WidgetType>(['github-prs', 'rate-limits', 'modified-files'])
const HEIGHTS: ReadonlySet<string> = new Set(['S', 'M', 'L'])
const SINGLETONS: ReadonlySet<string> = new Set(SINGLETON_WIDGET_TYPES)

/**
 * Validates the PUT /api/widgets body. Returns a CLEAN copy (unknown keys
 * stripped — what we persist is exactly what we validated), or a French
 * error message for the 400 response.
 */
export function validateWidgets(value: unknown): { widgets: WidgetInstance[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'requête invalide : tableau de widgets attendu' }
  const widgets: WidgetInstance[] = []
  const ids = new Set<string>()
  const singletons = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { error: 'requête invalide : chaque widget doit être un objet' }
    }
    const w = entry as Record<string, unknown>
    if (typeof w.id !== 'string' || w.id.length === 0) return { error: 'requête invalide : « id » est requis' }
    if (ids.has(w.id)) return { error: `requête invalide : id dupliqué « ${w.id} »` }
    ids.add(w.id)
    if (typeof w.type !== 'string' || !TYPES.has(w.type)) return { error: `requête invalide : type inconnu « ${String(w.type)} »` }
    if (w.span !== 1 && w.span !== 2) return { error: 'requête invalide : « span » doit être 1 ou 2' }
    if (typeof w.height !== 'string' || !HEIGHTS.has(w.height)) return { error: 'requête invalide : « height » doit être S, M ou L' }
    const clean: WidgetInstance = { id: w.id, type: w.type as WidgetType, span: w.span, height: w.height as WidgetInstance['height'] }
    if (w.type === 'github-prs') {
      if (typeof w.config !== 'object' || w.config === null || Array.isArray(w.config)) {
        return { error: 'requête invalide : « config » (avec repo) est requis pour github-prs' }
      }
      const config = w.config as Record<string, unknown>
      if (typeof config.repo !== 'string' || !REPO_PATTERN.test(config.repo)) {
        return { error: 'requête invalide : « config.repo » doit être de la forme owner/repo' }
      }
      if (config.limit !== undefined && (!Number.isInteger(config.limit) || (config.limit as number) < 1 || (config.limit as number) > 30)) {
        return { error: 'requête invalide : « config.limit » doit être un entier entre 1 et 30' }
      }
      clean.config = { repo: config.repo, ...(config.limit !== undefined ? { limit: config.limit as number } : {}) }
    } else {
      if (w.config !== undefined) return { error: `requête invalide : « config » n'est pas accepté pour ${w.type}` }
      if (SINGLETONS.has(w.type)) {
        if (singletons.has(w.type)) return { error: `requête invalide : « ${w.type} » ne peut apparaître qu'une fois` }
        singletons.add(w.type)
      }
    }
    widgets.push(clean)
  }
  return { widgets }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/routes/validate-widgets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/validate-widgets.ts apps/server/src/routes/validate-widgets.test.ts
git commit -m "feat(server): widget layout validation (strip + French 400 messages)"
```

### Task 4: `GET/PUT /api/widgets` routes

**Files:**
- Modify: `apps/server/src/routes/settings-routes.ts`
- Test: `apps/server/src/app.test.ts` (append — route tests live there, house pattern)

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/app.test.ts` (reuse its `freshApp` helper and header style):

```ts
describe('widgets routes', () => {
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

  test('GET /api/widgets returns the default layout on a fresh store', async () => {
    const { app } = freshApp()
    const res = await app.request('/api/widgets', { headers })
    expect(res.status).toBe(200)
    const widgets = (await res.json()) as { type: string }[]
    expect(widgets.map((w) => w.type)).toEqual(['rate-limits', 'modified-files'])
  })

  test('PUT /api/widgets replaces the layout atomically (empty array allowed) and persists', async () => {
    const { app, data } = freshApp()
    const res = await app.request('/api/widgets', { method: 'PUT', headers, body: JSON.stringify([]) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(data.get().widgets).toEqual([])
  })

  test('PUT /api/widgets rejects an invalid layout with a French 400 and keeps the stored one', async () => {
    const { app, data } = freshApp()
    const before = data.get().widgets
    const res = await app.request('/api/widgets', {
      method: 'PUT',
      headers,
      body: JSON.stringify([{ id: 'x', type: 'clock', span: 2, height: 'M' }]),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('type inconnu')
    expect(data.get().widgets).toEqual(before)
  })

  test('PUT /api/widgets survives any legal JSON body (body-guard convention)', async () => {
    const { app } = freshApp()
    for (const body of ['null', '"x"', '42', '{}']) {
      const res = await app.request('/api/widgets', { method: 'PUT', headers, body })
      expect(res.status).toBe(400)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/app.test.ts`
Expected: FAIL — 404 on `/api/widgets`.

- [ ] **Step 3: Implement**

In `apps/server/src/routes/settings-routes.ts`, import `validateWidgets` and add (near the Preferences block):

```ts
  // Widgets — dashboard layout (spec 2026-07-21). PUT is an atomic whole-array
  // replacement: one source of truth, no per-widget PATCH. Note: the body is
  // an ARRAY, so readJsonObject (objects only) does not apply here.
  app.get('/widgets', (c) => {
    return c.json(data.get().widgets)
  })

  app.put('/widgets', async (c) => {
    let parsed: unknown
    try {
      parsed = await c.req.json()
    } catch {
      return c.json({ error: 'requête invalide : corps JSON attendu' }, 400)
    }
    const result = validateWidgets(parsed)
    if ('error' in result) return c.json({ error: result.error }, 400)
    data.update((d) => {
      d.widgets = result.widgets
    })
    return c.json(data.get().widgets)
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/settings-routes.ts apps/server/src/app.test.ts
git commit -m "feat(server): GET/PUT /api/widgets (atomic layout replacement)"
```

**Chunk 1 exit criteria:** `bun test apps/server packages/shared` green; `GET/PUT /api/widgets` validated, persisted, defaulting to `DEFAULT_WIDGETS`.

---

## Chunk 2: Web dashboard grid

### Task 5: Web backend seam (`getWidgets`/`putWidgets`) + fixtures

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/api/backend.ts`, `apps/web/src/state/fixtures.ts`
- Modify: `apps/web/src/App.test.tsx` — its `fakeBackend()` (~line 35) enumerates every `Backend` member explicitly; it MUST gain the two new members or the type-check gate below fails (TS2739)

No new test file — this is pure plumbing exercised by every component test that follows (house pattern: the seam is covered through its consumers). Type-check is the gate here.

- [ ] **Step 1: Extend the REST client**

In `apps/web/src/api/client.ts`:

1. Add `WidgetInstance` to the `@atelier/shared` type import.
2. Improve `request()` so widget/GitHub error messages reach the UI (the server ships actionable French `{ error }` bodies). Replace the `if (!response.ok) throw ...` line with:

```ts
  if (!response.ok) {
    // Surface the server's French { error } message when present — the PR
    // widget and the layout toast display it verbatim.
    let detail: string | null = null
    try {
      detail = ((await response.json()) as { error?: string }).error ?? null
    } catch {
      // non-JSON body — keep the generic message
    }
    throw new ApiError(response.status, detail ?? `${method} /api${path} → ${response.status}`)
  }
```

3. Add at the end:

```ts
// ── Widgets ──

export function getWidgets(): Promise<WidgetInstance[]> {
  return request<WidgetInstance[]>('GET', '/widgets')
}

export function putWidgets(widgets: WidgetInstance[]): Promise<WidgetInstance[]> {
  return request<WidgetInstance[]>('PUT', '/widgets', widgets)
}
```

- [ ] **Step 2: Extend the Backend seam + fixtures**

In `apps/web/src/state/fixtures.ts`, add:

```ts
import { DEFAULT_WIDGETS, type WidgetInstance } from '@atelier/shared'

/** Demo layout: the default panels — the PR widget joins in chunk 2. */
export const fixtureWidgets: WidgetInstance[] = [...DEFAULT_WIDGETS]
```

(Adapt to the file's existing import/export style.)

In `apps/web/src/api/backend.ts`:

1. Add to the `Backend` type:

```ts
  /** Dashboard layout (array order = display order). */
  getWidgets: () => Promise<WidgetInstance[]>
  /** Atomic whole-array replacement — resolves to the stored layout. */
  putWidgets: (widgets: WidgetInstance[]) => Promise<WidgetInstance[]>
```

2. `realBackend`: `getWidgets: client.getWidgets, putWidgets: client.putWidgets,`
3. `createFixtureBackend()`: seed `let widgets: WidgetInstance[] = fixtureWidgets.map((w) => ({ ...w }))` and implement:

```ts
    getWidgets: async () => widgets,
    putWidgets: async (next) => {
      widgets = next.map((w) => ({ ...w }))
      return widgets
    },
```

4. `apps/web/src/App.test.tsx` — add to `fakeBackend()`:

```ts
    getWidgets: async () => [...DEFAULT_WIDGETS],
    putWidgets: async (next) => next,
```

(import `DEFAULT_WIDGETS` from `@atelier/shared`)

- [ ] **Step 3: Type-check and run the web suite**

Run: `bunx tsc -p apps/web --noEmit 2>/dev/null || bunx tsc --noEmit` (use the repo's tsconfig layout — check `apps/web/tsconfig.json` exists first; otherwise rely on `bun test apps/web`)
Run: `bun test apps/web`
Expected: PASS (no consumer yet).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/api/backend.ts apps/web/src/state/fixtures.ts
git commit -m "feat(web): widgets backend seam (REST + fixtures, error passthrough)"
```

### Task 6: dnd-kit dependency + reorder helper + widget registry

**Files:**
- Modify: `apps/web/package.json` (via bun add)
- Create: `apps/web/src/components/widgets/widget-registry.ts`
- Create: `apps/web/src/components/widgets/reorder.ts`
- Test: `apps/web/src/components/widgets/reorder.test.ts`

- [ ] **Step 1: Install dnd-kit**

Run: `bun add --cwd apps/web @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`
Expected: three deps added to `apps/web/package.json`.

- [ ] **Step 2: Write the failing reorder test**

Create `apps/web/src/components/widgets/reorder.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { WidgetInstance } from '@atelier/shared'
import { reorderWidgets } from './reorder'

const layout: WidgetInstance[] = [
  { id: 'a', type: 'rate-limits', span: 2, height: 'M' },
  { id: 'b', type: 'modified-files', span: 2, height: 'M' },
  { id: 'c', type: 'github-prs', span: 1, height: 'S', config: { repo: 'o/r' } },
]

describe('reorderWidgets', () => {
  test('moves the dragged id to the drop target position', () => {
    expect(reorderWidgets(layout, 'a', 'c').map((w) => w.id)).toEqual(['b', 'c', 'a'])
    expect(reorderWidgets(layout, 'c', 'a').map((w) => w.id)).toEqual(['c', 'a', 'b'])
  })

  test('unknown ids or self-drop return the SAME array (no useless PUT)', () => {
    expect(reorderWidgets(layout, 'a', 'a')).toBe(layout)
    expect(reorderWidgets(layout, 'nope', 'a')).toBe(layout)
    expect(reorderWidgets(layout, 'a', 'nope')).toBe(layout)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test apps/web/src/components/widgets/reorder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement reorder + registry**

Create `apps/web/src/components/widgets/reorder.ts`:

```ts
import { arrayMove } from '@dnd-kit/sortable'
import type { WidgetInstance } from '@atelier/shared'

/**
 * Pure onDragEnd logic — unit-tested here so the DashboardGrid wiring stays a
 * thin, untestable-DnD-free shell. Returns the ORIGINAL array when nothing
 * moves (callers skip the PUT on referential equality).
 */
export function reorderWidgets(widgets: WidgetInstance[], activeId: string, overId: string): WidgetInstance[] {
  if (activeId === overId) return widgets
  const from = widgets.findIndex((w) => w.id === activeId)
  const to = widgets.findIndex((w) => w.id === overId)
  if (from === -1 || to === -1) return widgets
  return arrayMove(widgets, from, to)
}
```

Create `apps/web/src/components/widgets/widget-registry.ts`:

```ts
import type { WidgetInstance, WidgetType } from '@atelier/shared'

export type WidgetMeta = {
  /** Heading shown by WidgetFrame (the frame owns the h3 — panels drop theirs). */
  title: string
  /** false → greyed in the palette once present. */
  multiInstance: boolean
  /** Fresh instance for « + Widget ». */
  create: () => WidgetInstance
}

/** Chunk 2 registry — github-prs joins in chunk 3 (Task 15). */
export const WIDGET_META: Partial<Record<WidgetType, WidgetMeta>> = {
  'rate-limits': {
    title: 'Limites du plan',
    multiInstance: false,
    create: () => ({ id: crypto.randomUUID(), type: 'rate-limits', span: 2, height: 'M' }),
  },
  'modified-files': {
    title: 'Fichiers modifiés — session',
    multiInstance: false,
    create: () => ({ id: crypto.randomUUID(), type: 'modified-files', span: 2, height: 'M' }),
  },
}
```

**Note:** titles above are the panels' EXACT current `<h3>` strings (`ModifiedFilesPanel.tsx:64` = « Fichiers modifiés — session ») — the frame takes over the heading in Task 7 and the visible text must not change. Double-check `RateLimitsPanel.tsx`'s heading string before committing and correct `title` if it differs.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test apps/web/src/components/widgets/reorder.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json bun.lock apps/web/src/components/widgets
git commit -m "feat(web): dnd-kit dep, pure reorder helper, widget registry"
```

### Task 7: WidgetFrame (chrome) + panels drop their own headings

**Files:**
- Create: `apps/web/src/components/widgets/WidgetFrame.tsx`
- Test: `apps/web/src/components/widgets/WidgetFrame.test.tsx`
- Modify: `apps/web/src/components/RateLimitsPanel.tsx`, `apps/web/src/components/ModifiedFilesPanel.tsx` (+ their tests)

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/widgets/WidgetFrame.test.tsx` (copy the RTL boilerplate — `IS_REACT_ACT_ENVIRONMENT`, `afterEach(cleanup)` — from `ModifiedFilesPanel.test.tsx`):

```tsx
import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WidgetInstance } from '@atelier/shared'
import { WidgetFrame } from './WidgetFrame'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const instance: WidgetInstance = { id: 'w1', type: 'rate-limits', span: 2, height: 'M' }

function renderFrame(over: Partial<Parameters<typeof WidgetFrame>[0]> = {}) {
  const changes: WidgetInstance[] = []
  const removed: string[] = []
  render(
    <WidgetFrame
      instance={instance}
      title="Limites du plan"
      onChange={(next) => changes.push(next)}
      onRemove={(id) => removed.push(id)}
      {...over}
    >
      <div>corps du widget</div>
    </WidgetFrame>,
  )
  return { changes, removed }
}

describe('WidgetFrame', () => {
  test('renders heading, body, and span/height classes', () => {
    renderFrame()
    screen.getByRole('heading', { name: 'Limites du plan' })
    screen.getByText('corps du widget')
    const frame = screen.getByRole('group', { name: 'Limites du plan' })
    expect(frame.className).toContain('span-2')
    expect(frame.className).toContain('h-M')
  })

  // Radix menus open on POINTERDOWN or Enter/Space keydown — NOT on click —
  // and render items async in a portal. House reference: ModelSelector.test.tsx
  // (openMenu = keyDown Enter + await findByRole). fireEvent.click on the
  // trigger does NOT open the menu.
  const openMenu = async () => {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Options du widget' }), { key: 'Enter' })
    await screen.findAllByRole('menuitem')
  }

  test('menu: height change emits a patched instance', async () => {
    const { changes } = renderFrame()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hauteur L' }))
    expect(changes).toEqual([{ ...instance, height: 'L' }])
  })

  test('menu: width change emits a patched instance', async () => {
    const { changes } = renderFrame()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Demi-largeur' }))
    expect(changes).toEqual([{ ...instance, span: 1 }])
  })

  test('menu: remove emits the id; configure hidden without onConfigure', async () => {
    const { removed } = renderFrame()
    await openMenu()
    expect(screen.queryByRole('menuitem', { name: 'Configurer…' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retirer' }))
    expect(removed).toEqual(['w1'])
  })
})
```

**Radix note:** the repo HAS a dropdown wrapper — `apps/web/src/components/ui/dropdown-menu.tsx`, already used by `ModelSelector.tsx`. Use it (mirror ModelSelector's imports/structure) instead of the raw `@radix-ui/react-dropdown-menu` namespace shown in the sample below; trigger/content/item map 1:1. The house reference for TESTING Radix menus is `ModelSelector.test.tsx` (keyDown Enter + `findByRole`), NOT SettingsPanel (native controls only).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/components/widgets/WidgetFrame.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement WidgetFrame**

Create `apps/web/src/components/widgets/WidgetFrame.tsx`:

```tsx
import type { ReactNode } from 'react'
import type { WidgetInstance } from '@atelier/shared'
// Use the ui/ wrapper if it exists, else the Radix primitives:
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

export type WidgetFrameProps = {
  instance: WidgetInstance
  title: string
  /** Emits a patched COPY — the caller owns persistence (optimistic PUT). */
  onChange: (next: WidgetInstance) => void
  onRemove: (id: string) => void
  /** Present only for configurable types (github-prs) — hides the item otherwise. */
  onConfigure?: () => void
  /** Spread onto the drag handle by DashboardGrid (dnd-kit listeners). */
  dragHandleProps?: Record<string, unknown>
  children: ReactNode
}

/**
 * Widget chrome: heading (the frame OWNS the h3 — wrapped panels render
 * body-only), drag handle, ⋯ menu (width, height, configure, remove).
 * Layout classes (`span-*`, `h-*`) are consumed by .dash-grid in styles.css.
 */
export function WidgetFrame({ instance, title, onChange, onRemove, onConfigure, dragHandleProps, children }: WidgetFrameProps) {
  return (
    <section className={`widget span-${instance.span} h-${instance.height}`} role="group" aria-label={title}>
      <header className="widget-head">
        <button type="button" className="widget-drag" aria-label={`Déplacer ${title}`} {...dragHandleProps}>
          ⠿
        </button>
        <h3>{title}</h3>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="widget-menu-btn" aria-label="Options du widget">
              ⋯
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="widget-menu" align="end">
              <DropdownMenu.Item onSelect={() => onChange({ ...instance, span: instance.span === 2 ? 1 : 2 })}>
                {instance.span === 2 ? 'Demi-largeur' : 'Pleine largeur'}
              </DropdownMenu.Item>
              {(['S', 'M', 'L'] as const).filter((h) => h !== instance.height).map((h) => (
                <DropdownMenu.Item key={h} onSelect={() => onChange({ ...instance, height: h })}>
                  {`Hauteur ${h}`}
                </DropdownMenu.Item>
              ))}
              {onConfigure !== undefined && <DropdownMenu.Item onSelect={onConfigure}>Configurer…</DropdownMenu.Item>}
              <DropdownMenu.Item onSelect={() => onRemove(instance.id)}>Retirer</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>
      <div className="widget-body">{children}</div>
    </section>
  )
}
```

- [ ] **Step 4: Strip the panels' own `<h3>`**

The frame now owns the heading; remove the `<h3>…</h3>` from `RateLimitsPanel.tsx` and `ModifiedFilesPanel.tsx` and update their tests (remove/adjust any assertion on the heading text — keep everything else intact).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test apps/web/src/components`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components
git commit -m "feat(web): WidgetFrame chrome (menu, sizes) — frame owns the heading"
```

### Task 8: DashboardGrid + « + Widget » palette

**Files:**
- Create: `apps/web/src/components/widgets/DashboardGrid.tsx`
- Test: `apps/web/src/components/widgets/DashboardGrid.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/widgets/DashboardGrid.test.tsx` (same RTL boilerplate):

```tsx
import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WidgetInstance } from '@atelier/shared'
import { DashboardGrid } from './DashboardGrid'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const layout: WidgetInstance[] = [
  { id: 'a', type: 'rate-limits', span: 2, height: 'M' },
  { id: 'b', type: 'modified-files', span: 1, height: 'S' },
]

function renderGrid(widgets: WidgetInstance[] = layout) {
  const saved: WidgetInstance[][] = []
  render(
    <DashboardGrid
      widgets={widgets}
      onSave={(next) => saved.push(next)}
      renderWidget={(w) => <div data-testid={`body-${w.type}`} />}
    />,
  )
  return { saved }
}

// Radix menus open on keyDown Enter (see ModelSelector.test.tsx) — items are async.
const openMenuOn = async (trigger: HTMLElement) => {
  fireEvent.keyDown(trigger, { key: 'Enter' })
  await screen.findAllByRole('menuitem')
}

describe('DashboardGrid', () => {
  test('renders one framed widget per instance, in order, with registry titles', () => {
    renderGrid()
    const groups = screen.getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Limites du plan', 'Fichiers modifiés — session'])
    screen.getByTestId('body-rate-limits')
    screen.getByTestId('body-modified-files')
  })

  test('remove emits the layout without the widget', async () => {
    const { saved } = renderGrid()
    await openMenuOn(screen.getAllByRole('button', { name: 'Options du widget' })[0]!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retirer' }))
    expect(saved).toEqual([[layout[1]]])
  })

  test('size change emits the patched layout', async () => {
    const { saved } = renderGrid()
    await openMenuOn(screen.getAllByRole('button', { name: 'Options du widget' })[1]!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hauteur L' }))
    expect(saved).toEqual([[layout[0], { ...layout[1], height: 'L' }]])
  })

  test('palette: present singletons disabled; adding appends a fresh instance', async () => {
    const { saved } = renderGrid([layout[0]!])
    await openMenuOn(screen.getByRole('button', { name: '+ Widget' }))
    expect(screen.getByRole('menuitem', { name: 'Limites du plan' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fichiers modifiés — session' }))
    expect(saved).toHaveLength(1)
    expect(saved[0]![1]!.type).toBe('modified-files')
  })

  test('empty layout: only the « + Widget » affordance renders', () => {
    renderGrid([])
    expect(screen.queryAllByRole('group')).toHaveLength(0)
    screen.getByRole('button', { name: '+ Widget' })
  })
})
```

(If `aria-disabled` doesn't reflect under happy-dom, assert `data-disabled` instead — match what Radix actually renders.)

**Testing deviation (deliberate — do NOT "fix" ad hoc):** the spec names a dnd-kit keyboard-sensor reorder test; simulating DnD under happy-dom is brittle, so reorder LOGIC is unit-tested via `reorderWidgets` (Task 6) and the `onDragEnd` wiring stays a thin shell verified in the browser at Task 9 Step 4.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/components/widgets/DashboardGrid.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DashboardGrid**

Create `apps/web/src/components/widgets/DashboardGrid.tsx`:

```tsx
import type { ReactNode } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { WidgetInstance, WidgetType } from '@atelier/shared'
import { WIDGET_META, type WidgetMeta } from './widget-registry'
import { reorderWidgets } from './reorder'
import { WidgetFrame } from './WidgetFrame'

export type DashboardGridProps = {
  widgets: WidgetInstance[]
  /** Every mutation (reorder, resize, add, remove, configure) emits the FULL next layout — the caller PUTs it optimistically. */
  onSave: (next: WidgetInstance[]) => void
  /** App owns data: maps an instance to its body. Return null for types the app cannot render (defensive). */
  renderWidget: (instance: WidgetInstance) => ReactNode
  /** Opens the config dialog for a configurable instance (chunk 2 wires it). */
  onConfigure?: (instance: WidgetInstance) => void
}

/** Layout/chrome only — no data fetching in here (spec boundary). */
export function DashboardGrid({ widgets, onSave, renderWidget, onConfigure }: DashboardGridProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const onDragEnd = (event: DragEndEvent) => {
    if (event.over === null) return
    const next = reorderWidgets(widgets, String(event.active.id), String(event.over.id))
    if (next !== widgets) onSave(next)
  }

  const patch = (next: WidgetInstance) => onSave(widgets.map((w) => (w.id === next.id ? next : w)))
  const remove = (id: string) => onSave(widgets.filter((w) => w.id !== id))
  const add = (type: WidgetType) => {
    const meta = WIDGET_META[type]
    if (meta !== undefined) onSave([...widgets, meta.create()])
  }

  const presentTypes = new Set(widgets.map((w) => w.type))

  return (
    <div className="dash-widgets">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="add-widget">+ Widget</button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="widget-menu" align="end">
            {/* Cast REQUIRED: WIDGET_META is Partial<Record<...>> — bare Object.entries infers `WidgetMeta | undefined` and fails strict tsc. */}
            {(Object.entries(WIDGET_META) as [WidgetType, WidgetMeta][]).map(([type, meta]) => {
              const disabled = !meta.multiInstance && presentTypes.has(type)
              return (
                <DropdownMenu.Item key={type} disabled={disabled} onSelect={() => add(type)}>
                  {meta.title}
                </DropdownMenu.Item>
              )
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
          <div className="dash-grid">
            {widgets.map((instance) => (
              <SortableWidget
                key={instance.id}
                instance={instance}
                onChange={patch}
                onRemove={remove}
                onConfigure={onConfigure}
                renderWidget={renderWidget}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

function SortableWidget({ instance, onChange, onRemove, onConfigure, renderWidget }: {
  instance: WidgetInstance
  onChange: (next: WidgetInstance) => void
  onRemove: (id: string) => void
  onConfigure?: (instance: WidgetInstance) => void
  renderWidget: (instance: WidgetInstance) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: instance.id })
  const meta = WIDGET_META[instance.type]
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, display: 'contents' }}>
      <WidgetFrame
        instance={instance}
        title={meta?.title ?? instance.type}
        onChange={onChange}
        onRemove={onRemove}
        onConfigure={onConfigure !== undefined && instance.type === 'github-prs' ? () => onConfigure(instance) : undefined}
        dragHandleProps={{ ...attributes, ...listeners }}
      >
        {renderWidget(instance)}
      </WidgetFrame>
    </div>
  )
}
```

**Implementation note:** `display: 'contents'` on the sortable wrapper keeps the `section.widget` as the grid child so `span-*` classes work — verify the drag preview still behaves in the browser (Step 6); if it doesn't, move the span/height classes up to the wrapper div instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/components/widgets/DashboardGrid.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/widgets
git commit -m "feat(web): DashboardGrid — sortable widgets + palette"
```

### Task 9: Wire the grid into App + styles

**Files:**
- Modify: `apps/web/src/App.tsx` (the `<aside>` block, lines ~286-291, plus queries)
- Modify: `apps/web/src/styles.css` (Right panel section, ~line 272)
- Test: `apps/web/src/App.test.tsx` (adjust)

- [ ] **Step 1: Extend App**

In `apps/web/src/App.tsx`:

1. Imports: `DashboardGrid` from `./components/widgets/DashboardGrid`; `DEFAULT_WIDGETS, type WidgetInstance` from `@atelier/shared`.
2. Add the layout query + optimistic mutation (near the other queries):

```tsx
  // Dashboard layout — fallback to the shared default so a fetch failure
  // still renders a usable dashboard (spec: edits keep failing visibly).
  // FALLBACK_WIDGETS is a MODULE-LEVEL constant (declare it above the App
  // component: `const FALLBACK_WIDGETS: WidgetInstance[] = [...DEFAULT_WIDGETS]`)
  // — an inline `[...DEFAULT_WIDGETS]` would be a fresh array every render.
  const widgetsQuery = useQuery({ queryKey: ['widgets'], queryFn: backend.getWidgets, retry: false })
  const widgets = widgetsQuery.data ?? FALLBACK_WIDGETS

  const saveWidgets = useMutation({
    mutationFn: backend.putWidgets,
    // Optimistic: drag/resize must feel instant; rollback + toast on failure.
    onMutate: async (next: WidgetInstance[]) => {
      await queryClient.cancelQueries({ queryKey: ['widgets'] })
      const previous = queryClient.getQueryData<WidgetInstance[]>(['widgets'])
      queryClient.setQueryData(['widgets'], next)
      return { previous }
    },
    onError: (error, _next, context) => {
      queryClient.setQueryData(['widgets'], context?.previous)
      setNotice(`Impossible d’enregistrer le layout : ${errorMessage(error)}`)
    },
    onSuccess: (stored) => queryClient.setQueryData(['widgets'], stored),
  })
```

3. Add the renderer (before `return`):

```tsx
  const renderWidget = (w: WidgetInstance) => {
    switch (w.type) {
      case 'rate-limits':
        return <RateLimitsPanel limits={usageLimitsQuery.data ?? []} />
      case 'modified-files':
        return <ModifiedFilesPanel files={stream.modifiedFiles} api={{ openInIde: backend.openInIde }} />
      default:
        return null // github-prs arrives in chunk 3
    }
  }
```

4. Replace the `<aside>` body:

```tsx
        <aside className="dash" aria-label="Tableau de bord">
          <DashboardGrid widgets={widgets} onSave={(next) => saveWidgets.mutate(next)} renderWidget={renderWidget} />
        </aside>
```

(Keep the 0.1.6 comment about plan limits being the only usage surface — move it above `renderWidget`.)

- [ ] **Step 2: Styles**

In `apps/web/src/styles.css`, extend the Right panel section (keep `.dash` and `.dash h3` as-is — the frame's `h3` inherits the house heading style):

```css
  .dash-widgets { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .add-widget { align-self: flex-end; padding: 4px 9px; font: 600 11px var(--font-mono); color: var(--color-faint); background: transparent; border: 1px dashed var(--color-line); border-radius: 7px; cursor: pointer; }
  .dash-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-flow: row dense; gap: 10px; }
  .widget { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--color-line); border-radius: 10px; background: rgba(18, 24, 40, 0.6); }
  .widget.span-2 { grid-column: span 2; }
  .widget.h-S .widget-body { height: 96px; }
  .widget.h-M .widget-body { height: 200px; }
  .widget.h-L .widget-body { height: 320px; }
  .widget-body { overflow-y: auto; padding: 8px 10px 10px; min-height: 0; }
  .widget-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px 0; }
  .widget-head h3 { flex: 1; margin: 0; }
  .widget-drag { cursor: grab; background: none; border: none; color: var(--color-faint); padding: 0 2px; }
  .widget-menu-btn { background: none; border: none; color: var(--color-faint); cursor: pointer; padding: 0 2px; }
  .widget-menu { background: #141a2c; border: 1px solid var(--color-line); border-radius: 8px; padding: 4px; font: 500 12px var(--font-sans, sans-serif); color: inherit; }
  .widget-menu [data-highlighted] { background: rgba(255, 255, 255, 0.06); border-radius: 5px; }
  .widget-menu [data-disabled] { opacity: 0.4; }
```

(Adjust color literals to the file's existing CSS variables — read the `:root` block and reuse tokens instead of hex where one exists.)

- [ ] **Step 3: Add the rollback-on-failure test (spec-mandated), fix App tests, run everything**

Append to `apps/web/src/App.test.tsx` (use its existing render helper + `fakeBackend` override pattern; open the widget menu with the ModelSelector keyDown pattern):

```tsx
  test('PUT /widgets failure: layout rolls back and a notice appears', async () => {
    const backend = { ...fakeBackend(), putWidgets: async () => { throw new Error('boom') } }
    render(<App backend={backend} />)  // adapt to the file's render helper
    // remove a widget → optimistic removal, then rollback on the rejected PUT
    fireEvent.keyDown((await screen.findAllByRole('button', { name: 'Options du widget' }))[0]!, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Retirer' }))
    await screen.findByText(/Impossible d’enregistrer le layout/)
    // the widget is back (rollback restored the previous layout)
    expect(screen.getAllByRole('group')).toHaveLength(2)
  })
```

Run: `bun test apps/web`
Expected: `App.test.tsx` may assert on the old aside content — update those assertions to the framed widgets (`role="group"` with the registry titles). Everything else PASS, including the new rollback test.

- [ ] **Step 4: See it work (dev, fixtures)**

Follow the parallel-jobs check first, then: `bun run dev:web` with `VITE_USE_FIXTURES=1` (check how the repo usually sets it — likely `VITE_USE_FIXTURES=1 bun run dev:web`), open http://localhost:4518.
Expected: right column shows the two framed panels; drag reorders; menu resizes; « + Widget » works; a reload keeps the fixture default (fixtures don't persist — fine).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/styles.css apps/web/src/App.test.tsx
git commit -m "feat(web): dashboard grid replaces the static aside"
```

**Chunk 2 exit criteria:** `bun test` fully green; the dashboard renders the two panels, supports reorder/resize/add/remove, persists through the real server, rolls back visibly on PUT failure, and falls back to `DEFAULT_WIDGETS` when the layout fetch fails.

---

## Chunk 3: GitHub proxy + PR widget

### Task 10: `githubUser` preference

**Files:**
- Modify: `packages/shared/src/protocol.ts` (Preferences), `apps/server/src/store/app-data.ts` (EMPTY), `apps/server/src/routes/settings-routes.ts` (PATCH)
- Modify: `apps/web/src/components/SettingsPanel.test.tsx` — it builds a full `Preferences` literal (~line 12), the only one in the repo; add `githubUser: 'alice-dev'` to it or `tsc --noEmit` breaks silently later (bun test has no type gate)
- Test: `apps/server/src/app.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to the preferences tests in `apps/server/src/app.test.ts` (find the existing PATCH /api/preferences tests and follow their style):

```ts
  test('githubUser: defaults to alice-dev, PATCHable, string-validated', async () => {
    const { app } = freshApp()
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
    const before = await (await app.request('/api/preferences', { headers })).json() as { githubUser: string }
    expect(before.githubUser).toBe('alice-dev')
    const patched = await app.request('/api/preferences', { method: 'PATCH', headers, body: JSON.stringify({ githubUser: 'g-grum' }) })
    expect(((await patched.json()) as { githubUser: string }).githubUser).toBe('g-grum')
    const bad = await app.request('/api/preferences', { method: 'PATCH', headers, body: JSON.stringify({ githubUser: 42 }) })
    expect(bad.status).toBe(400)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/app.test.ts`
Expected: FAIL — `githubUser` undefined.

- [ ] **Step 3: Implement**

1. `packages/shared/src/protocol.ts` — add to `Preferences`:

```ts
  /** gh CLI keyring account used by the GitHub proxy — pinned so the active-account switch (atelier release ops) never breaks the PR widget. */
  githubUser: string
```

2. `apps/server/src/store/app-data.ts` — add to `EMPTY.preferences`: `githubUser: 'alice-dev',` (the per-key preferences deep-merge gives legacy files the default for free).
3. `apps/server/src/routes/settings-routes.ts` — in PATCH `/preferences`, validate + apply like `defaultModel`:

```ts
    if (parsed.githubUser !== undefined && typeof parsed.githubUser !== 'string') {
      return c.json({ error: 'requête invalide : « githubUser » doit être une chaîne' }, 400)
    }
```

and in `data.update`: `if (githubUser !== undefined) d.preferences.githubUser = githubUser` (with the corresponding `const githubUser = parsed.githubUser as string | undefined`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts apps/server/src/store/app-data.ts apps/server/src/routes/settings-routes.ts apps/server/src/app.test.ts
git commit -m "feat(server): githubUser preference (pinned gh account)"
```

### Task 11: GithubService — runner seam, token pinning, cache, mapping

**Files:**
- Create: `apps/server/src/github/gh-runner.ts`
- Create: `apps/server/src/github/github-service.ts`
- Test: `apps/server/src/github/github-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/github/github-service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { GithubError, GithubService } from './github-service'
import type { GhRun } from './gh-runner'

const RAW_PR = {
  number: 1276,
  title: 'SUP-90 - Fix frozen page',
  url: 'https://github.com/o/r/pull/1276',
  author: { login: 'alice-dev' },
  state: 'MERGED',
  isDraft: false,
  updatedAt: '2026-07-17T12:22:41Z',
  headRefName: 'fix/sup-90',
  reviewDecision: 'APPROVED',
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
}

type Call = { args: string[]; env: Record<string, string> | undefined }

function fakeRunner(responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) {
  const calls: Call[] = []
  const run: GhRun = async (args, env) => {
    calls.push({ args, env })
    const key = args[0] === 'auth' ? 'auth' : 'list'
    const r = responses[key] ?? {}
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 }
  }
  return { run, calls }
}

const okRunner = () => fakeRunner({ auth: { stdout: 'tok-123\n' }, list: { stdout: JSON.stringify([RAW_PR]) } })

describe('GithubService', () => {
  test('lists PRs with the pinned token and maps fields', async () => {
    const { run, calls } = okRunner()
    const service = new GithubService(run, () => 0)
    const prs = await service.listPrs('o/r', 10, 'alice-dev')
    expect(calls[0]!.args).toEqual(['auth', 'token', '--user', 'alice-dev'])
    expect(calls[1]!.env).toEqual({ GH_TOKEN: 'tok-123' })
    expect(calls[1]!.args).toContain('--state')
    expect(prs).toEqual([{
      number: 1276,
      title: 'SUP-90 - Fix frozen page',
      url: 'https://github.com/o/r/pull/1276',
      author: 'alice-dev',
      state: 'merged',
      updatedAt: '2026-07-17T12:22:41Z',
      branch: 'fix/sup-90',
      ci: 'passed',
      review: 'approved',
    }])
  })

  test.each([
    ['draft', { ...RAW_PR, state: 'OPEN', isDraft: true }, 'draft'],
    ['open', { ...RAW_PR, state: 'OPEN', isDraft: false }, 'open'],
    ['closed', { ...RAW_PR, state: 'CLOSED' }, 'closed'],
  ] as const)('state mapping: %s', async (_n, raw, expected) => {
    const { run } = fakeRunner({ auth: { stdout: 't' }, list: { stdout: JSON.stringify([raw]) } })
    const prs = await new GithubService(run, () => 0).listPrs('o/r', 10, 'u')
    expect(prs[0]!.state).toBe(expected)
  })

  test.each([
    ['null when no checks', [], null],
    ['failed beats pending', [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }], 'failed'],
    ['pending when any incomplete', [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }], 'pending'],
    ['passed when all green', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], 'passed'],
  ] as const)('ci mapping: %s', async (_n, rollup, expected) => {
    const { run } = fakeRunner({ auth: { stdout: 't' }, list: { stdout: JSON.stringify([{ ...RAW_PR, statusCheckRollup: rollup }]) } })
    const prs = await new GithubService(run, () => 0).listPrs('o/r', 10, 'u')
    expect(prs[0]!.ci).toBe(expected)
  })

  test('review mapping: CHANGES_REQUESTED / REVIEW_REQUIRED / empty', async () => {
    for (const [decision, expected] of [['CHANGES_REQUESTED', 'changes_requested'], ['REVIEW_REQUIRED', 'required'], ['', null]] as const) {
      const { run } = fakeRunner({ auth: { stdout: 't' }, list: { stdout: JSON.stringify([{ ...RAW_PR, reviewDecision: decision }]) } })
      const prs = await new GithubService(run, () => 0).listPrs('o/r', 10, 'u')
      expect(prs[0]!.review).toBe(expected)
    }
  })

  test('cache: same repo:limit within 60s does not re-run gh; expiry re-fetches', async () => {
    let now = 0
    const { run, calls } = okRunner()
    const service = new GithubService(run, () => now)
    await service.listPrs('o/r', 10, 'u')
    await service.listPrs('o/r', 10, 'u')
    expect(calls.filter((c) => c.args[0] === 'pr')).toHaveLength(1)
    now = 61_000
    await service.listPrs('o/r', 10, 'u')
    expect(calls.filter((c) => c.args[0] === 'pr')).toHaveLength(2)
  })

  test('token cached per user; changing githubUser re-resolves', async () => {
    const { run, calls } = okRunner()
    const service = new GithubService(run, () => 0)
    await service.listPrs('o/r', 10, 'user-a')
    await service.listPrs('o/r2', 10, 'user-a')
    await service.listPrs('o/r3', 10, 'user-b')
    expect(calls.filter((c) => c.args[0] === 'auth')).toHaveLength(2)
  })

  test('auth failure and gh failure throw GithubError with actionable French messages', async () => {
    // await is REQUIRED on .rejects — unawaited, the assertion can silently pass.
    const authFail = fakeRunner({ auth: { exitCode: 1, stderr: 'no oauth token' } })
    await expect(new GithubService(authFail.run, () => 0).listPrs('o/r', 10, 'u')).rejects.toThrow(GithubError)
    const listFail = fakeRunner({ auth: { stdout: 't' }, list: { exitCode: 1, stderr: 'GraphQL: Could not resolve' } })
    await expect(new GithubService(listFail.run, () => 0).listPrs('o/r', 10, 'u')).rejects.toThrow('Could not resolve')
  })

  test('gh missing (exit 127 from the runner) surfaces the runner message, not a misleading auth error', async () => {
    const missing = fakeRunner({ auth: { exitCode: 127, stderr: 'gh introuvable (/opt/homebrew/bin/gh) — installe GitHub CLI : brew install gh' } })
    await expect(new GithubService(missing.run, () => 0).listPrs('o/r', 10, 'u')).rejects.toThrow('gh introuvable')
  })

  test('errors are not cached — the next call retries', async () => {
    const responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }> = { auth: { stdout: 't' }, list: { exitCode: 1, stderr: 'boom' } }
    const { run, calls } = fakeRunner(responses)
    const service = new GithubService(run, () => 0)
    await service.listPrs('o/r', 10, 'u').catch(() => {})
    responses.list = { stdout: JSON.stringify([RAW_PR]) }
    const prs = await service.listPrs('o/r', 10, 'u')
    expect(prs).toHaveLength(1)
    expect(calls.filter((c) => c.args[0] === 'pr')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/github/github-service.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the runner seam**

Create `apps/server/src/github/gh-runner.ts`:

```ts
/** Subprocess seam — the service never spawns directly (tests inject a fake). */
export type GhRun = (args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string; exitCode: number }>

const TIMEOUT_MS = 10_000

/**
 * Real runner. gh path: PATH lookup with a Homebrew fallback — a Dock launch
 * gets a minimal PATH (same constraint as bunPath in the desktop shell).
 */
export function createGhRunner(ghPath: string = Bun.which('gh') ?? '/opt/homebrew/bin/gh'): GhRun {
  return async (args, env) => {
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn([ghPath, ...args], {
        env: { ...process.env, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch {
      return { stdout: '', stderr: `gh introuvable (${ghPath}) — installe GitHub CLI : brew install gh`, exitCode: 127 }
    }
    // Timeout tracked with a LOCAL flag: proc.exited is Promise<number> in
    // bun-types (never null — do not compare to null, tsc flags it TS2367).
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, TIMEOUT_MS)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (timedOut) {
        return { stdout, stderr: stderr.trim() || 'gh a dépassé le délai de 10 s', exitCode: exitCode === 0 ? 124 : exitCode }
      }
      return { stdout, stderr, exitCode }
    } finally {
      clearTimeout(timeout)
    }
  }
}
```

- [ ] **Step 4: Implement the service**

Create `apps/server/src/github/github-service.ts`:

```ts
import type { PrCi, PrReview, PrState, PrSummary } from '@atelier/shared'
import type { GhRun } from './gh-runner'

/** Actionable, user-displayable failure (→ 502 { error }); anything else is a bug. */
export class GithubError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubError'
  }
}

const CACHE_TTL_MS = 60_000
const FIELDS = 'number,title,url,author,state,isDraft,updatedAt,headRefName,reviewDecision,statusCheckRollup'

type RawPr = {
  number: number
  title: string
  url: string
  author?: { login?: string }
  state: string
  isDraft?: boolean
  updatedAt: string
  headRefName?: string
  reviewDecision?: string
  statusCheckRollup?: { status?: string; conclusion?: string }[] | null
}

export class GithubService {
  /** Token pinned per gh keyring user — immune to `gh auth switch` (release ops). */
  private token: { user: string; value: string } | null = null
  private readonly cache = new Map<string, { at: number; prs: PrSummary[] }>()

  constructor(
    private readonly run: GhRun,
    private readonly now: () => number = Date.now,
  ) {}

  async listPrs(repo: string, limit: number, githubUser: string): Promise<PrSummary[]> {
    const key = `${repo}:${limit}`
    const hit = this.cache.get(key)
    if (hit !== undefined && this.now() - hit.at < CACHE_TTL_MS) return hit.prs

    const token = await this.resolveToken(githubUser)
    const result = await this.run(
      ['pr', 'list', '-R', repo, '--state', 'all', '--limit', String(limit), '--json', FIELDS],
      { GH_TOKEN: token },
    )
    if (result.exitCode !== 0) {
      throw new GithubError(`gh a échoué pour ${repo} : ${result.stderr.trim() || 'erreur inconnue'}`)
    }
    let raw: RawPr[]
    try {
      raw = JSON.parse(result.stdout) as RawPr[]
    } catch {
      throw new GithubError(`réponse gh illisible pour ${repo}`)
    }
    const prs = raw.map(mapPr)
    this.cache.set(key, { at: this.now(), prs })
    return prs
  }

  private async resolveToken(user: string): Promise<string> {
    if (this.token !== null && this.token.user === user) return this.token.value
    const result = await this.run(['auth', 'token', '--user', user])
    const value = result.stdout.trim()
    if (result.exitCode !== 0 || value.length === 0) {
      const detail = result.stderr.trim()
      // exit 127 = the runner itself failed (gh binary missing) — its message
      // is already actionable; a « pas authentifié » prefix would mislead.
      if (result.exitCode === 127 && detail.length > 0) throw new GithubError(detail)
      throw new GithubError(`gh n'est pas authentifié pour « ${user} » : ${detail || 'gh auth login requis'}`)
    }
    this.token = { user, value }
    return value
  }
}

function mapPr(raw: RawPr): PrSummary {
  const state: PrState =
    raw.isDraft === true && raw.state === 'OPEN' ? 'draft'
    : raw.state === 'MERGED' ? 'merged'
    : raw.state === 'CLOSED' ? 'closed'
    : 'open'
  const rollup = raw.statusCheckRollup ?? []
  const ci: PrCi =
    rollup.length === 0 ? null
    : rollup.some((c) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR') ? 'failed'
    : rollup.some((c) => c.status !== 'COMPLETED') ? 'pending'
    : 'passed'
  const review: PrReview =
    raw.reviewDecision === 'APPROVED' ? 'approved'
    : raw.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested'
    : raw.reviewDecision === 'REVIEW_REQUIRED' ? 'required'
    : null
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? '?',
    state,
    updatedAt: raw.updatedAt,
    branch: raw.headRefName ?? '',
    ci,
    review,
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test apps/server/src/github/github-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/github
git commit -m "feat(server): GithubService — gh runner seam, pinned token, 60s cache"
```

### Task 12: `GET /api/github/prs` route

**Files:**
- Create: `apps/server/src/github/github-routes.ts`
- Modify: `apps/server/src/app.ts` (mount), `apps/server/src/index.ts` (composition root)
- Test: `apps/server/src/app.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/app.test.ts`. Extend `freshApp` with an optional `github?: GithubService` parameter (default `undefined`) forwarded to `createApp`; build fakes with the fakeRunner pattern from the service tests (import `GithubService`):

```ts
describe('github routes', () => {
  const headers = { Authorization: 'Bearer test-token' }
  const service = (responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) =>
    new GithubService(async (args) => {
      const r = responses[args[0] === 'auth' ? 'auth' : 'list'] ?? {}
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 }
    })

  test('GET /api/github/prs returns mapped PRs', async () => {
    const github = service({ auth: { stdout: 't' }, list: { stdout: JSON.stringify([{ number: 1, title: 'T', url: 'u', author: { login: 'a' }, state: 'OPEN', updatedAt: 'now' }]) } })
    const { app } = freshApp(undefined, undefined, undefined, github)
    const res = await app.request('/api/github/prs?repo=o/r', { headers })
    expect(res.status).toBe(200)
    const prs = (await res.json()) as { number: number; state: string }[]
    expect(prs).toEqual([expect.objectContaining({ number: 1, state: 'open' })])
  })

  test('400 on bad repo or bad limit', async () => {
    const { app } = freshApp(undefined, undefined, undefined, service({}))
    expect((await app.request('/api/github/prs?repo=no-slash', { headers })).status).toBe(400)
    expect((await app.request('/api/github/prs?repo=o/r&limit=0', { headers })).status).toBe(400)
    expect((await app.request('/api/github/prs?repo=o/r&limit=abc', { headers })).status).toBe(400)
    expect((await app.request('/api/github/prs?repo=o/r&limit=31', { headers })).status).toBe(400)
  })

  test('502 with the French message on gh failure', async () => {
    const github = service({ auth: { exitCode: 1, stderr: 'nope' } })
    const { app } = freshApp(undefined, undefined, undefined, github)
    const res = await app.request('/api/github/prs?repo=o/r', { headers })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toContain('authentifié')
  })
})
```

(Adapt the `freshApp` signature change to its actual parameter list — turn positional params into an options object if that reads better; update existing call sites mechanically.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/app.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

Create `apps/server/src/github/github-routes.ts`:

```ts
import { Hono } from 'hono'
import { REPO_PATTERN } from '@atelier/shared'
import type { AppData } from '../store/app-data'
import { GithubError, GithubService } from './github-service'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30

export function githubRoutes(github: GithubService, data: AppData): Hono {
  const app = new Hono()

  // Read-only proxy: all failures land as 400 (caller bug) or 502 (gh/GitHub
  // unavailable) with a French, widget-displayable { error } — never a 500.
  app.get('/github/prs', async (c) => {
    const repo = c.req.query('repo') ?? ''
    if (!REPO_PATTERN.test(repo)) {
      return c.json({ error: 'requête invalide : « repo » doit être de la forme owner/repo' }, 400)
    }
    const limitRaw = c.req.query('limit')
    const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return c.json({ error: `requête invalide : « limit » doit être un entier entre 1 et ${MAX_LIMIT}` }, 400)
    }
    try {
      return c.json(await github.listPrs(repo, limit, data.get().preferences.githubUser))
    } catch (err) {
      if (err instanceof GithubError) return c.json({ error: err.message }, 502)
      console.error('[github-routes] unexpected failure:', err)
      return c.json({ error: 'erreur inattendue en interrogeant GitHub' }, 502)
    }
  })

  return app
}
```

Wire-up:
- `apps/server/src/app.ts`: add `github: GithubService` to `createApp`'s options; `api.route('/', githubRoutes(github, data))` next to the other routes.
- `apps/server/src/index.ts`: construct `new GithubService(createGhRunner())` at the composition root and pass it in (follow how `streams`/`sessions` are built there).
- `apps/server/src/app.test.ts`: `freshApp` builds a default no-op fake service when none is injected (so pre-existing tests keep passing without touching gh).

- [ ] **Step 4: Run the server suite**

Run: `bun test apps/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/github apps/server/src/app.ts apps/server/src/index.ts apps/server/src/app.test.ts
git commit -m "feat(server): GET /api/github/prs behind the pinned-account proxy"
```

### Task 13: Web seam for PRs + fixtures

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/api/backend.ts`, `apps/web/src/state/fixtures.ts`

- [ ] **Step 1: Implement (plumbing — gated by type-check + downstream tests)**

1. `client.ts`:

```ts
// ── GitHub ──

export function getGithubPrs(repo: string, limit: number): Promise<PrSummary[]> {
  return request<PrSummary[]>('GET', `/github/prs?repo=${encodeURIComponent(repo)}&limit=${limit}`)
}
```

(add `PrSummary` to the shared type import)

2. `fixtures.ts` — exercise EVERY visual state offline (spec):

```ts
export const fixturePrs: PrSummary[] = [
  { number: 1281, title: 'PRO-2044 - Nouveau système de filtres', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1281', author: 'alice-dev', state: 'open', updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), branch: 'feat/pro-2044', ci: 'pending', review: 'required' },
  { number: 1280, title: 'Fix - Workspace switcher crash', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1280', author: 'carol-dev', state: 'open', updatedAt: new Date(Date.now() - 5 * 3600_000).toISOString(), branch: 'fix/switcher', ci: 'failed', review: 'changes_requested' },
  { number: 1279, title: 'Draft - Exploration virtualisation', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1279', author: 'bob-dev', state: 'draft', updatedAt: new Date(Date.now() - 8 * 3600_000).toISOString(), branch: 'spike/virtualization', ci: null, review: null },
  { number: 1276, title: 'SUP-90 - Fix frozen page after closing clause modal', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1276', author: 'alice-dev', state: 'merged', updatedAt: new Date(Date.now() - 26 * 3600_000).toISOString(), branch: 'fix/sup-90', ci: 'passed', review: 'approved' },
  { number: 1274, title: 'Chore - Update @jsfns', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1274', author: 'bob-dev', state: 'closed', updatedAt: new Date(Date.now() - 30 * 3600_000).toISOString(), branch: 'chore/jsfns', ci: 'passed', review: null },
]
```

Also add one `github-prs` instance to `fixtureWidgets` (span 2, height M, `config: { repo: 'acme-corp/demoapp-frontend', limit: 10 }`).

3. `backend.ts`:
- `Backend` type: `getGithubPrs: (repo: string, limit: number) => Promise<PrSummary[]>`
- real: `getGithubPrs: client.getGithubPrs,`
- fixtures: `getGithubPrs: async (_repo, limit) => fixturePrs.slice(0, limit),`

- [ ] **Step 2: Verify**

Run: `bun test apps/web`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api apps/web/src/state/fixtures.ts
git commit -m "feat(web): PR backend seam + demo fixtures (all visual states)"
```

### Task 14: PrListWidget

**Files:**
- Create: `apps/web/src/components/widgets/PrListWidget.tsx`
- Test: `apps/web/src/components/widgets/PrListWidget.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/widgets/PrListWidget.test.tsx` (RTL boilerplate + a `QueryClientProvider` wrapper — the widget owns a `useQuery`):

```tsx
import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PrSummary } from '@atelier/shared'
import { formatAge, PrListWidget } from './PrListWidget'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const prs: PrSummary[] = [
  { number: 1, title: 'Open pending', url: 'https://x/1', author: 'a', state: 'open', updatedAt: new Date().toISOString(), branch: 'b1', ci: 'pending', review: 'required' },
  { number: 2, title: 'Merged green', url: 'https://x/2', author: 'b', state: 'merged', updatedAt: new Date().toISOString(), branch: 'b2', ci: 'passed', review: 'approved' },
]

function renderWidget(impl: () => Promise<PrSummary[]>) {
  const opened: string[] = []
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PrListWidget repo="o/r" limit={10} api={{ getGithubPrs: impl }} openUrl={(url) => opened.push(url)} />
    </QueryClientProvider>,
  )
  return { opened }
}

describe('PrListWidget', () => {
  test('renders one compact row per PR (title, state dot, age)', async () => {
    renderWidget(async () => prs)
    await waitFor(() => screen.getByText('Open pending'))
    screen.getByText('Merged green')
    expect(document.querySelectorAll('.pr-dot')).toHaveLength(2)
  })

  test('row click expands inline details; second click collapses', async () => {
    renderWidget(async () => prs)
    await waitFor(() => screen.getByText('Open pending'))
    fireEvent.click(screen.getByRole('button', { name: /Open pending/ }))
    screen.getByText('#1')
    screen.getByText('b1')
    screen.getByText(/CI en cours/)
    screen.getByText(/review requise/i)
    fireEvent.click(screen.getByRole('button', { name: /Open pending/ }))
    expect(screen.queryByText('#1')).toBeNull()
  })

  test('↗ opens the PR url without toggling the row', async () => {
    const { opened } = renderWidget(async () => prs)
    await waitFor(() => screen.getByText('Open pending'))
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir la PR #1 sur GitHub' }))
    expect(opened).toEqual(['https://x/1'])
    expect(screen.queryByText('b1')).toBeNull()
  })

  test('error state shows the server message and retries on click', async () => {
    let failures = 1
    renderWidget(async () => {
      if (failures-- > 0) throw new Error("gh n'est pas authentifié pour « alice-dev »")
      return prs
    })
    await waitFor(() => screen.getByText(/authentifié/))
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => screen.getByText('Open pending'))
  })

  test('empty state', async () => {
    renderWidget(async () => [])
    await waitFor(() => screen.getByText('Aucune PR récente'))
  })
})

describe('formatAge', () => {
  test('minutes, hours, days', () => {
    const now = new Date('2026-07-21T12:00:00Z')
    expect(formatAge('2026-07-21T11:58:00Z', now)).toBe('2 min')
    expect(formatAge('2026-07-21T09:00:00Z', now)).toBe('3 h')
    expect(formatAge('2026-07-18T09:00:00Z', now)).toBe('3 j')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/components/widgets/PrListWidget.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/widgets/PrListWidget.tsx`:

```tsx
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PrSummary } from '@atelier/shared'
import { errorMessage } from '../../lib/utils'

export type PrListWidgetApi = { getGithubPrs: (repo: string, limit: number) => Promise<PrSummary[]> }

export type PrListWidgetProps = {
  repo: string
  limit: number
  api: PrListWidgetApi
  /** Injectable for tests — production opens the system browser via the Electron window-open handler. */
  openUrl?: (url: string) => void
}

const STATE_LABEL: Record<PrSummary['state'], string> = { open: 'ouverte', merged: 'mergée', closed: 'fermée', draft: 'brouillon' }
const CI_LABEL = { passed: 'CI verte', failed: 'CI en échec', pending: 'CI en cours' } as const
const REVIEW_LABEL = { approved: 'review approuvée', changes_requested: 'changements demandés', required: 'review requise' } as const

export function formatAge(updatedAt: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(updatedAt)) / 60_000))
  if (minutes < 60) return `${minutes} min`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / (24 * 60))} j`
}

/**
 * Compact-extensible list (spec): one line per PR, click expands inline
 * details, ↗ opens GitHub. All failure states stay INSIDE the widget.
 */
export function PrListWidget({ repo, limit, api, openUrl = (url) => window.open(url, '_blank', 'noopener') }: PrListWidgetProps) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const query = useQuery({
    queryKey: ['github-prs', repo, limit],
    queryFn: () => api.getGithubPrs(repo, limit),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  })

  if (query.status === 'pending') return <div className="pr-skeleton" aria-hidden="true" />
  if (query.status === 'error') {
    return (
      <div className="pr-error" role="alert">
        <span>{errorMessage(query.error)}</span>
        <button type="button" className="banner-btn" onClick={() => void query.refetch()}>
          Réessayer
        </button>
      </div>
    )
  }
  if (query.data.length === 0) return <p className="pr-empty">Aucune PR récente</p>

  return (
    <ul className="pr-list">
      {query.data.map((pr) => (
        <li key={pr.number} className="pr-item">
          <div className="pr-row">
            <button
              type="button"
              className="pr-line"
              aria-expanded={expanded === pr.number}
              onClick={() => setExpanded((current) => (current === pr.number ? null : pr.number))}
            >
              <span className={`pr-dot ${pr.state}`} title={STATE_LABEL[pr.state]} />
              <span className="pr-title">{pr.title}</span>
              <span className="pr-age">{formatAge(pr.updatedAt)}</span>
            </button>
            <button type="button" className="pr-open" aria-label={`Ouvrir la PR #${pr.number} sur GitHub`} onClick={() => openUrl(pr.url)}>
              ↗
            </button>
          </div>
          {expanded === pr.number && (
            <div className="pr-details">
              <span>#{pr.number}</span> · <span>{pr.author}</span> · <span>{pr.branch}</span> · <span>{STATE_LABEL[pr.state]}</span>
              {pr.ci !== null && <> · <span>{CI_LABEL[pr.ci]}</span></>}
              {pr.review !== null && <> · <span>{REVIEW_LABEL[pr.review]}</span></>}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
```

Add styles to `apps/web/src/styles.css` (Right panel section, reuse existing tokens):

```css
  .pr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .pr-item { border-bottom: 1px solid var(--color-line); }
  .pr-item:last-child { border-bottom: none; }
  .pr-row { display: flex; align-items: center; gap: 4px; }
  .pr-line { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; padding: 5px 0; background: none; border: none; color: inherit; cursor: pointer; text-align: left; font: inherit; }
  .pr-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .pr-dot.open { background: #3fb950; }
  .pr-dot.merged { background: #a371f7; }
  .pr-dot.closed { background: #f85149; }
  .pr-dot.draft { background: #8b949e; }
  .pr-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .pr-age { color: var(--color-faint); font: 500 10px var(--font-mono); flex: none; }
  .pr-open { background: none; border: none; color: var(--color-faint); cursor: pointer; padding: 2px 4px; }
  .pr-details { padding: 0 0 7px 14px; color: var(--color-faint); font-size: 11px; }
  .pr-empty, .pr-error { color: var(--color-faint); font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
  .pr-skeleton { height: 60px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/components/widgets/PrListWidget.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/widgets/PrListWidget.tsx apps/web/src/components/widgets/PrListWidget.test.tsx apps/web/src/styles.css
git commit -m "feat(web): PrListWidget — compact-extensible PR list"
```

### Task 15: Config dialog + registry entry + App wiring

**Files:**
- Create: `apps/web/src/components/widgets/PrConfigDialog.tsx`
- Test: `apps/web/src/components/widgets/PrConfigDialog.test.tsx`
- Modify: `apps/web/src/components/widgets/widget-registry.ts`, `apps/web/src/App.tsx`

- [ ] **Step 1: Write the failing dialog test**

Create `apps/web/src/components/widgets/PrConfigDialog.test.tsx` (Radix dialog — follow `SettingsPanel.test.tsx` patterns):

```tsx
import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WidgetInstance } from '@atelier/shared'
import { PrConfigDialog } from './PrConfigDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const instance: WidgetInstance = { id: 'p1', type: 'github-prs', span: 2, height: 'M', config: { repo: 'o/r', limit: 10 } }

function renderDialog() {
  const saved: WidgetInstance[] = []
  const closed: boolean[] = []
  render(<PrConfigDialog instance={instance} onSave={(next) => saved.push(next)} onClose={() => closed.push(true)} />)
  return { saved, closed }
}

describe('PrConfigDialog', () => {
  test('prefills repo and limit', () => {
    renderDialog()
    expect((screen.getByLabelText('Repo (owner/nom)') as HTMLInputElement).value).toBe('o/r')
    expect((screen.getByLabelText('Nombre de PRs') as HTMLInputElement).value).toBe('10')
  })

  test('save emits the patched instance and closes', () => {
    const { saved, closed } = renderDialog()
    fireEvent.change(screen.getByLabelText('Repo (owner/nom)'), { target: { value: 'acme-corp/demoapp-backend' } })
    fireEvent.change(screen.getByLabelText('Nombre de PRs'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(saved).toEqual([{ ...instance, config: { repo: 'acme-corp/demoapp-backend', limit: 5 } }])
    expect(closed).toEqual([true])
  })

  test('invalid repo shows the error and does not save', () => {
    const { saved } = renderDialog()
    fireEvent.change(screen.getByLabelText('Repo (owner/nom)'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    screen.getByText(/owner\/repo/)
    expect(saved).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/components/widgets/PrConfigDialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement dialog + registry + App**

Create `apps/web/src/components/widgets/PrConfigDialog.tsx` — a small Radix dialog (reuse `components/ui` dialog wrapper if present, else `@radix-ui/react-dialog` like `SettingsPanel`): two labelled fields (`Repo (owner/nom)` text, `Nombre de PRs` number 1–30), client-side check with `REPO_PATTERN` (shared), French error `« repo » doit être de la forme owner/repo`, buttons `Annuler` / `Enregistrer`. `onSave` emits `{ ...instance, config: { repo, limit } }` then `onClose()`.

Modify `widget-registry.ts` — add:

```ts
  'github-prs': {
    title: 'Pull Requests',
    multiInstance: true,
    create: () => ({
      id: crypto.randomUUID(),
      type: 'github-prs',
      span: 2,
      height: 'M',
      config: { repo: 'acme-corp/demoapp-frontend', limit: 10 },
    }),
  },
```

Modify `App.tsx`:

1. State: `const [configuring, setConfiguring] = useState<WidgetInstance | null>(null)`
2. `renderWidget` gains:

```tsx
      case 'github-prs':
        return <PrListWidget repo={w.config?.repo ?? ''} limit={w.config?.limit ?? 10} api={{ getGithubPrs: backend.getGithubPrs }} />
```

3. Pass `onConfigure={setConfiguring}` to `DashboardGrid`; render next to `<Toaster />`:

```tsx
      {configuring !== null && (
        <PrConfigDialog
          instance={configuring}
          onSave={(next) => saveWidgets.mutate(widgets.map((w) => (w.id === next.id ? next : w)))}
          onClose={() => setConfiguring(null)}
        />
      )}
```

- [ ] **Step 4: Run the web suite**

Run: `bun test apps/web`
Expected: PASS (adjust `App.test.tsx` if it asserts the widget set — fixtures now include a PR widget).

- [ ] **Step 5: See it work (dev, fixtures)**

`VITE_USE_FIXTURES=1 bun run dev:web` → the PR widget renders every state (open/pending, failed/changes_requested, draft, merged/approved, closed); expansion, ↗, configuration and multi-instance add all work.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/widgets apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): PR widget wired — registry, config dialog, multi-instance"
```

### Task 16: Electron — external links to the system browser

**Files:**
- Modify: `apps/desktop/src/main.ts` (`createWindow`, ~line 108)

- [ ] **Step 1: Implement**

`main.ts` has no test harness (thin shell by design) — this is a manual-verification change. In `createWindow()`, after the `BrowserWindow` construction, add:

```ts
  // External links (PR widget ↗, target="_blank"): open in the system browser,
  // NEVER in a child BrowserWindow. Local (loopback) URLs are denied outright —
  // the app is single-window by design.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.includes('127.0.0.1') && !url.includes('localhost')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
```

and add `shell` to the `electron` import.

- [ ] **Step 2: Verify manually**

Follow the parallel-jobs check, then `bun run build:web && bun run --cwd apps/desktop dev` (or the packaged app): click a PR's ↗ — the system browser opens the PR; no new Electron window appears.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "feat(desktop): route external links to the system browser"
```

### Task 17: Full verification + release note

- [ ] **Step 1: Full suite**

Run: `bun test`
Expected: PASS, no skips.

- [ ] **Step 2: Real end-to-end pass**

Parallel-jobs check, then real dev run (no fixtures): server + web, dashboard loads the persisted layout, PR widget shows real `acme-corp/demoapp-frontend` activity (requires `gh` authenticated for `alice-dev`), reorder survives a reload, a second PR widget on `acme-corp/demoapp-backend` works.

- [ ] **Step 3: Release (owner's call)**

House release workflow when the owner wants to ship: bump `version.json` (version + concise French notes, e.g. « Tableau de bord de widgets personnalisable », « Widget Pull Requests GitHub ») + `bun run build:web` — the running app toasts the update. Do NOT bump without asking.

- [ ] **Step 4: Final commit if anything moved**

```bash
git status --short   # commit any stragglers with an appropriate message
```
