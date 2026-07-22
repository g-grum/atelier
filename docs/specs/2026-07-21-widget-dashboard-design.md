# Widget dashboard & GitHub PRs widget — design

Date: 2026-07-21 · Status: validated with owner (Germain) through brainstorming.

## Purpose

Turn the static right column into a **modular widget dashboard** the owner arranges at will, and add a **GitHub Pull Requests widget** showing the latest activity of a configurable repository (first target: `acme-corp/demoapp-frontend`). The chat remains Atelier's core; the dashboard never blocks it.

## Decisions (owner-validated)

1. **PR content** — recent activity: latest PRs across ALL states (open, merged, closed, draft), sorted by `updatedAt`. Chosen over open-only (often empty on this high-velocity repo) and "my PRs" views.
2. **Modularity level** — a widget grid (drag & drop reorder + per-widget size), chosen over show/hide-only panels and over saved named views (presets can layer on later).
3. **Grid emprise** — the right column at its current fixed width (~306px). No resizable split, no full-screen dashboard mode.
4. **PR widget density** — compact one-line rows; clicking a row expands inline details (author, branch, CI, review); a ↗ affordance opens the PR on GitHub in the system browser.
5. **Multi-instance** — the PR widget can be added several times, each instance carrying its own config (`repo`, `limit`). Other widget types stay singletons.
6. **Tech** — front: `@dnd-kit/sortable` + native CSS grid (no react-grid-layout); back: the server proxies GitHub through the `gh` CLI with a token pinned to a fixed account (see GitHub proxy).
7. **Usage cards stay dead** — 0.1.6 (`0cfd48b`, landed mid-brainstorm) dropped the token usage cards; owner confirmed the widget catalog follows: `rate-limits`, `modified-files`, `github-prs` only. No resurrection of `session-usage`/`global-usage` as widgets.

## Current state (what exists)

- `App.tsx` renders a static `<aside class="dash">` with **two** panels, each fed by App-owned data: `RateLimitsPanel` (`usageLimitsQuery`) and `ModifiedFilesPanel` (`stream.modifiedFiles` + `openInIde`). (0.1.6 / `0cfd48b` removed the token usage cards — « plan limits are the only usage surface ».)
- `AppData` persists a JSON file; top-level keys load via shallow spread `{ ...EMPTY, ...parsed }`, so a new top-level key with a default is backward compatible for free. `preferences` deep-merges per key.
- Settings routes: `GET/PATCH /api/preferences`, plus projects/rules/usage. Body-guard convention: any legal JSON body → 4xx, never a 500.
- Web stack: React 19, Tailwind 4, Radix, react-query 5, `Backend` seam with real + fixtures implementations. No drag & drop dependency yet.
- `gh` CLI at `/opt/homebrew/bin/gh`, **multi-account**: active account is normally `alice-dev` (pro, has access to `acme-corp/*`), but Atelier release operations temporarily switch to `g-grum` — the proxy must not depend on the active account.
- Electron shell: external-link routing (`shell.openExternal`) not yet verified — the PR widget needs it.

## Design

### Shared contracts (`packages/shared`)

```ts
export type WidgetType = 'github-prs' | 'rate-limits' | 'modified-files'
export type WidgetHeight = 'S' | 'M' | 'L'
export type WidgetInstance = {
  id: string                      // uuid, unique in the array
  type: WidgetType
  span: 1 | 2                     // grid columns occupied
  height: WidgetHeight            // fixed height tier; content scrolls internally
  config?: { repo: string; limit?: number }   // github-prs: REQUIRED (repo); other types: must be absent
}

export const DEFAULT_WIDGETS: WidgetInstance[]  // the 2 current panels — single source for server default AND web fallback

export type PrState = 'open' | 'merged' | 'closed' | 'draft'
export type PrCi = 'passed' | 'failed' | 'pending' | null
export type PrReview = 'approved' | 'changes_requested' | 'required' | null
export type PrSummary = {
  number: number
  title: string
  url: string
  author: string
  state: PrState
  updatedAt: string               // ISO
  branch: string
  ci: PrCi
  review: PrReview
}
```

Array order = display order. Height tiers map to fixed pixel heights in CSS (indicative: S ≈ 120, M ≈ 220, L ≈ 340 — tuned during implementation, not contractual).

### Server — widget layout persistence

- `AppDataShape.widgets: WidgetInstance[]`. `EMPTY` default = `DEFAULT_WIDGETS` (from `packages/shared`) mirroring today's aside so the first launch changes nothing: `rate-limits`, `modified-files`, each `span: 2, height: 'M'`. An existing app-data file without the key picks the default via the existing shallow spread.
- Routes (in `settings-routes.ts`):
  - `GET /api/widgets` → the stored array.
  - `PUT /api/widgets` → **atomic whole-array replacement** (single source of truth, no per-widget PATCH). Validation → 400 with a French message on: non-array body, unknown `type`, `span` not 1|2, `height` not S|M|L, missing/duplicate `id`, `github-prs` without `config.repo`, `config.repo` not matching `^[\w.-]+/[\w.-]+$`, `config.limit` not an integer in [1, 30], `config` present on a non-`github-prs` type. Multiple `github-prs` entries are allowed; duplicate singleton types are rejected (400). An **empty array is valid** (the user removed everything): the grid then shows only the « + Widget » affordance.

### Server — GitHub proxy (`apps/server/src/github/`)

- `GET /api/github/prs?repo=owner/name&limit=n` (limit default 10, max 30; `repo` validated with the same pattern as above; invalid → 400).
- Execution: `gh pr list -R <repo> --state all --limit <n> --json number,title,url,author,state,isDraft,updatedAt,headRefName,reviewDecision,statusCheckRollup`, then map to `PrSummary[]`:
  - `state`: `isDraft && state === 'OPEN'` → `draft`, else lowercase of OPEN/MERGED/CLOSED.
  - `ci`: `statusCheckRollup` empty/absent → `null`; any FAILURE/ERROR conclusion → `failed`; any PENDING/IN_PROGRESS/QUEUED status → `pending`; else → `passed`.
  - `review`: `APPROVED` → `approved`, `CHANGES_REQUESTED` → `changes_requested`, `REVIEW_REQUIRED` → `required`, absent/empty → `null`.
- **Account pinning**: on first use, the module resolves a token via `gh auth token --user <githubUser>` and passes it as `GH_TOKEN` to every `gh pr list` call — immune to the keyring's active-account switches. `githubUser` is a new preference (default `'alice-dev'`), editable through the existing `PATCH /api/preferences` (string validation like `ide`). Changing `githubUser` invalidates the cached token.
- **Runner seam**: `gh` execution goes through an injectable `runGh(args, env) => Promise<{ stdout, exitCode }>` (Bun subprocess in production) so route tests never spawn a process. 10 s timeout per call.
- **Cache**: in-memory `Map` keyed `repo:limit`, TTL 60 s, successful responses only. Keeps GitHub round-trips ≤ 1/min **per `repo:limit` pair** (two instances on the same repo with different limits fetch separately — accepted for a personal app).
- **Errors**: `gh` binary missing, not authenticated for `githubUser`, unknown repo, timeout, non-zero exit → `502 { error }` with an actionable French message (e.g. « gh introuvable — installe GitHub CLI » / « repo inconnu ou inaccessible : … »). Never a 500; never cached.

### Web — DashboardGrid (layout & chrome)

- `DashboardGrid` replaces the static `<aside>`. CSS grid, 2 columns, `grid-auto-flow: row dense`; each widget renders in a `WidgetFrame` whose `grid-column: span {1|2}` and height class come from its `WidgetInstance`.
- **Boundaries**: `DashboardGrid` owns layout, drag & drop and chrome; **App keeps owning data**. App passes `renderWidget(instance) => ReactNode` which maps each type to today's two panel components (unchanged) fed by App's existing queries/stream — plus the new PR widget. No context bag, no data fetching inside the grid.
- `WidgetFrame` header: title, drag handle, Radix ⋯ menu → width (1 or 2 columns), height (S/M/L), « Configurer… » (github-prs only), « Retirer ». Body scrolls internally when content exceeds the tier height.
- Reorder: `@dnd-kit/core` + `@dnd-kit/sortable` on the array order, drag restricted to the handle; the keyboard sensor stays enabled (accessibility + deterministic tests).
- Add: a « + Widget » button above the grid opens a Radix dropdown palette. Singleton types already present are disabled; `github-prs` is always addable (new instance defaults: `span 2`, `height M`, `config: { repo: 'acme-corp/demoapp-frontend', limit: 10 }`).
- Persistence: query `['widgets']` (GET) + a PUT mutation applied **optimistically** (drag feels instant); on failure, rollback to the previous array + toast « Impossible d'enregistrer le layout : … ».

### Web — PR widget (`PrListWidget`)

- Props: `{ repo, limit, api: { getGithubPrs } }` — instance config in (`repo` guaranteed by PUT validation; `limit` defaults to 10 when absent), backend seam injected like `ModifiedFilesPanel` does with `openInIde`.
- Compact row: colored state dot (open `green`, merged `violet`, closed `red`, draft `grey`), truncated title, relative age (« 2 h », « 3 j »). Click toggles an inline expansion: `#number`, author, branch, CI, review, full date. A ↗ affordance (row-level, and inside the expansion) opens `url` in the system browser.
- Query per instance: `['github-prs', repo, limit]`, `refetchInterval: 60_000`, `refetchOnWindowFocus: true`, `retry: false` — same posture as the usage queries.
- States: loading skeleton; empty (« Aucune PR récente ») ; error **inside the widget** with the server's message and a « Réessayer » button. Never a global banner; the chat is never blocked.
- Config dialog (Radix, opened from the ⋯ menu): `repo` text field + `limit` number field, client-validated with the shared pattern, saved through the same PUT mutation.
- **External links**: verify the Electron main process routes `window.open`/`target="_blank"` to `shell.openExternal` (via `setWindowOpenHandler`); add it if missing. Without it the PR link would open a rogue BrowserWindow.

### Backend seam & fixtures

`Backend` gains `getWidgets`, `putWidgets`, `getGithubPrs`. The fixtures implementation ships a plausible default layout and PR list (including one `failed` CI and one `changes_requested` review so every visual state is exercisable offline), following the existing fixtures pattern.

## Error handling summary

| Failure | Surface |
|---|---|
| `gh` missing / not authenticated / unknown repo / timeout | 502 `{ error }` → error state inside the PR widget + retry |
| Invalid `PUT /api/widgets` body | 400 `{ error }` → optimistic rollback + toast |
| Layout fetch failure at startup | Fall back to rendering `DEFAULT_WIDGETS` (shared constant — server default and web fallback cannot drift); widgets render, edits keep failing visibly via the toast path |
| GitHub rate limit | Same 502 path; 60 s cache makes it unlikely (≤ 1 call/min/repo) |

## Testing (TDD, house process)

- **Server / github**: route tests with an injected fake `runGh` — nominal mapping (states, CI rollup, review decisions), gh missing, non-zero exit, timeout, cache hit within TTL, account pinning (`GH_TOKEN` propagated, re-resolved after `githubUser` change), param validation.
- **Server / widgets**: GET default (fresh store and legacy file without the key → `DEFAULT_WIDGETS`), PUT happy path including the empty array, each 400 branch (unknown type, bad span/height, missing/duplicate id, `github-prs` without `config.repo`, `config` on a singleton type, duplicate singleton).
- **Web / DashboardGrid**: renders instances in order with spans/heights, add from palette (singleton disabled), remove, reorder via dnd-kit **keyboard sensor** (deterministic under happy-dom), optimistic PUT + rollback on failure.
- **Web / PrListWidget**: fixtures-driven — list rendering, inline expansion toggle, external-link call, error + retry, empty state.

## Plan phasing hint

Two cohesive units share this spec. The natural plan seam: **(1)** dashboard framework — shared contracts, server persistence, `DashboardGrid` hosting the two existing panels — ships as a working increment; **(2)** GitHub proxy + PR widget layers on top. The plan should follow that order.

## Out of scope (deliberate)

- Resizable chat/dashboard split, full-screen dashboard mode, saved named views (owner chose the fixed-width grid; presets can layer on later).
- PR write actions (merge, review, comment) — read-only surface.
- Other data widgets (CI runs, issues…) — the registry makes them cheap to add later.
- Multi-user/token management UI beyond the `githubUser` preference.
