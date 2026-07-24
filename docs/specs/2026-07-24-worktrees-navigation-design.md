# Worktrees: discover and work in git worktrees under a project — design

Date: 2026-07-24 · Status: validated with owner (Germain) through brainstorming.

## Purpose

A registered project (e.g. `~/workspace/demoapp-frontend`) often has many git
worktrees — created by agent tooling under `.claude/worktrees/<name>`, each on
its own branch with its own Claude Code session history. Today the only way to
work in one from Atelier is to register each worktree as a separate project:
tedious, clutters the sidebar, and does not follow worktrees as they come and
go.

Germain wants Atelier to **discover** a project's worktrees automatically and
let him **navigate into one and chat there** (turns run with `cwd` = the
worktree's path). Creating or removing worktrees stays out of scope — the
agent tooling owns their lifecycle.

## Decisions (owner-validated)

1. **Auto-discovery, navigation only.** Atelier lists a project's worktrees via
   `git worktree list`; no `git worktree add/remove` from the app.
2. **Nested in the sidebar.** A project row expands to list its worktrees
   (branch + session count); the main working directory stays the project root
   and is not repeated as a child.
3. **A worktree is just another `cwd`.** It plugs into the existing
   `projectId → path → cwd` machinery as a stateless, path-addressable
   workspace id. Nothing about worktrees is persisted — always read live from
   git.
4. **Per-worktree isolation of side-state.** Rules, model override and
   permission answers key off the worktree's stable id, so each worktree keeps
   its own (not shared with the parent).
5. **Registration is the trust anchor.** You can only reach worktrees of a
   folder you explicitly registered; a worktree path is validated against git
   before it is ever used as a `cwd`.

## Key insight

The whole session/stream/chat machinery already resolves a `projectId` to a
`project.path` and passes it as the Agent SDK `cwd` (`session-stream.ts:124`,
`sessions-service.ts:24-27`). A worktree is nothing more than a different
`cwd`. So instead of a new parallel concept, a worktree is exposed as a
**workspace id** that the same machinery accepts.

The change is *additive in spirit* but not free: a `projectId` is resolved to a
path (or guarded against the persisted projects list) in **six** places, not
two. Three of them are 400/404 guards that sit **upstream** of the two obvious
resolvers, so they must be widened first or a worktree turn is rejected before
any resolver runs. And one — the permission broker's `projectDir` — is resolved
**synchronously in a constructor**, while validating a `wt:` id needs an async
`git` call. The design below inventories all six and resolves the sync/async
mismatch by resolving the path once at the async entry points and **threading
the already-validated path** into the synchronous stream/broker constructor, so
no `git` call ever happens in a constructor.

## Current state (what exists)

- `Project = { id, path, color }` (persisted, `protocol.ts:24`);
  `ProjectSummary = Project & { sessionCount }` is the REST shape
  (`protocol.ts:26`). Projects are stored in `app-data.json`; worktrees are not
  a concept yet.
- **Six** sites turn a workspace id into a path (or gate it against the
  persisted projects list). All six must handle a `wt:` id or a worktree turn
  breaks:
  1. **WS guard** — `app.ts:66`: `data.get().projects.some(p => p.id ===
     projectId)` → **400** for any non-persisted id, *before* the stream is
     constructed. The web client builds the WS URL with the workspace id
     (`api/ws.ts`), so a `wt:` turn is dead on arrival unless this is widened.
  2. **GET sessions route** — `sessions-routes.ts:11-12`
     (`GET /projects/:id/sessions`): its own `projects.find(...)` → **404**
     before `SessionsService.list` runs. This is the endpoint
     `backend.listSessions` / the `['sessions', id]` query hits.
  3. **POST createDraft route** — `sessions-routes.ts:19-20`
     (`POST /projects/:id/sessions`): same `projects.find(...)` → **404**
     before `createDraft` runs. A draft in a worktree needs this widened.
  4. **`SessionStream.runTurn`** — `session-stream.ts:100`, then
     `cwd: project.path` at `:124`.
  5. **`SessionsService.list`** — `sessions-service.ts:24-27` (and thus
     `countSessions`).
  6. **`findOwningProject`** — `sessions-service.ts:184`: scans only persisted
     projects, so a session living in a worktree dir is not found for deletion.
- **Permission broker `projectDir`** — `session-stream.ts:48` resolves it
  synchronously in the `SessionStream` constructor:
  `projects.find(p => p.id === projectId)?.path ?? ''`. For a `wt:` id this is
  `''`, and `deriveProposedRule` (`derive-matcher.ts`) then builds the
  Edit/Write glob `` `${''}/**` `` = **`/**`** — an « always allow Edit »
  answered in a worktree would grant writes to the whole filesystem. This is a
  correctness *and* security-scoping bug, and it defeats Decision 4. The
  constructor is synchronous, so it cannot `await` a git-validating resolver —
  the path must arrive already resolved.
- `getSessionMessages(sessionId)` and `renameSession(sessionId, name)`
  (`sdk-client.ts`) take **no** dir — they resolve a session globally across
  `~/.claude/projects`. Session ids are unique, so these need no change.
- `AgentSdkClient.listSessions(cwd)` and `deleteSession(sessionId, dir)` take a
  dir; `encodeProjectDir` (`sdk-client.ts:379`) maps a cwd to its
  `~/.claude/projects/<encoded>` folder. Worktree session histories already
  live there under the worktree's encoded path.
- Side-maps in `app-data.json` — `modelOverrides`, `permissionModes`,
  `draftMap`, and `AlwaysRule.projectId` — are all keyed by the workspace id
  (today always a project id). A stable worktree id makes them work unchanged.
- `App.tsx` validates the open workspace against the persisted projects list:
  `projects.some(p => p.id === openProjectId) ? openProjectId : projects[0]?.id`
  (`App.tsx:159`), and the last-session restore effect checks the same list
  (`App.tsx:199-204`, membership check at `:203`). A worktree id is not in that
  list, so both must learn to
  accept a currently-known worktree id.
- `SessionSidebar` renders projects with color dots, per-project counts, and a
  `+ Projet` affordance. No expand/nesting yet.
- A GitHub proxy under `apps/server/src/github/` (a `gh`-CLI service + routes +
  60 s cache keyed on `repo:limit`) is the pattern to mirror for the git-CLI
  worktree unit.

## Design

### Identity & resolution (server)

A worktree's id is **`wt:` + base64url(absolute path)** — deterministic,
reversible, self-describing, and disjoint from the UUIDs used for persisted
projects. `wt:` is the discriminator.

A single shared **async** helper resolves any workspace id to a filesystem
path. It is async because validating a `wt:` id requires a `git` call
(read through the `WorktreeService` cache, below):

```
resolveWorkspacePath(id): Promise<string | null>
  - id matches a persisted project      → project.path
  - id starts with 'wt:'                 → decode (base64url) to a path, then
                                           VALIDATE membership: the path is a
                                           linked worktree of SOME registered
                                           project (appears in that project's
                                           cached `git worktree list`);
                                           valid → the path, else → null
  - a 'wt:' id decoding to a registered project's own root
                                        → null (use the project id for the root;
                                           the id space stays 1:1)
  - otherwise                            → null
```

Validation-before-use is the security boundary: the decoded base64 path is
never trusted on its own — it must belong to a **registered** project's `git
worktree list`. Registration is the trust anchor (Decision 5); this closes
path-traversal / arbitrary-`cwd` escalation via a forged `wt:` id.

### How each of the six sites is handled

The three **guards** (sites 1–3) are in async handlers/middleware, so they
`await resolveWorkspacePath(id)` and return their existing 400/404 when it is
`null` — widening the check from "is a persisted project" to "is a resolvable
workspace":

- Site 1 (`app.ts:66` WS guard): `await`; on success stash the resolved path
  via `c.set('workspacePath', path)` and pass it into
  `streams.get(id, projectId, path)` (see threading below).
- Sites 2 & 3 (`sessions-routes.ts`): replace `data.get().projects.find(...)`
  with `(await resolveWorkspacePath(id)) === null → 404`.

The two **resolvers** (sites 4–5) stop doing `projects.find(...)`:

- Site 5, `SessionsService.list(id)`: `const path = await
  resolveWorkspacePath(id); if (!path) throw` — so `countSessions` still maps
  the throw to 0, and the discovery route's per-worktree counts reuse the
  cached git result (no N+1 re-shelling).
- Site 4, `SessionStream.runTurn` (`:100-106`): the `projects.find(p => p.id
  === this.projectId)` lookup and its `unknown project` throw are **removed** —
  they would reject every `wt:` turn (a `wt:` id is not in the persisted list).
  `cwd` becomes `this.workspacePath` (threaded at construction, below). A
  defense-in-depth guard is kept but **re-based on the threaded path** (throw
  when `workspacePath` is falsy), not on `projects.find`. In practice it is
  unreachable — the WS guard already rejected an unresolvable id.

Site 6, `findOwningProject` (delete), scans persisted project paths **plus**
each project's cached worktree paths, so a session that lives in a worktree dir
finds its owning `cwd`. (Accepted cost: one cached `git worktree list` per
registered project per delete — negligible for a personal app.)

### Threading the validated path into the sync constructor

The `SessionStream` constructor (and the `PermissionBroker` it builds) is
synchronous and cannot `await` the resolver. So the **already-validated path**
is passed in:

- `SessionStreamRegistry.get(id, projectId, workspacePath)` gains the path
  param; the WS guard (the only caller that constructs streams) resolved it.
- `SessionStreamParams` carries `workspacePath`; the constructor passes it
  straight to `new PermissionBroker(data, projectId, workspacePath, …)` —
  fixing the `/**` glob bug — and `runTurn` uses it as the SDK `cwd`.
- The registry caches one stream per session on first connect, so the path is
  captured then; for a `wt:` id the path is stable (derived from the id), so
  caching is safe (documented).

### Discovery (server)

A new focused unit `apps/server/src/worktrees/`, mirroring the `github/`
structure:

- **Pure parser** of `git worktree list --porcelain` → `{ path, branch, locked
  }[]`. Porcelain emits per-worktree blocks (`worktree <path>`, `HEAD <sha>`,
  `branch refs/heads/<name>` or `detached`, optional `locked`/`bare`/`prunable`
  lines, blank-line separated). The parser: strips the `refs/heads/` prefix to
  a branch name; `detached` → `branch: null`; skips `bare`; and **excludes the
  main working directory** (the first block, whose path equals the project
  root) so the project row is not duplicated as its own child.
- **`WorktreeService.list(projectPath)`** shells `git -C <path> worktree list
  --porcelain`, feeds the parser, and **never throws** — a non-git folder or a
  git error yields `[]` (same tolerance as `countSessions`), so a project
  always expands, possibly to nothing. Results cached ~60 s per project path
  (mirror the github service's cache), invalidatable so a manual refresh is
  live.

**Wiring (DI).** `WorktreeService` is constructed once in the composition root
(`app.ts`/`index.ts`) alongside the existing services. `resolveWorkspacePath`
needs `AppData` + `WorktreeService`; it is created there too and injected
where the six sites live: into `sessionsRoutes(data, sessions, resolve)` (sites
2, 3), the WS guard closure in `createApp` (site 1), and `SessionsService`
(sites 5, 6 — its constructor gains the resolver/service so `list` and
`findOwningProject` can call it). `SessionStream`/`PermissionBroker` receive
only the already-resolved `workspacePath` string, so they need no `git`
dependency.

New route `GET /api/projects/:id/worktrees` (token-guarded like every `/api`
route): resolves the project, lists worktrees, and returns each enriched to
`Worktree` — `{ id: 'wt:'+b64(path), path, branch, sessionCount }`, the count
via the existing `countSessions(wtId)` (which now resolves the wt id to its
path). An unknown project id → `[]` (not 500). Counts are computed on the
listed worktrees only (a handful in practice); acceptable cost since the
endpoint is fetched lazily on expand.

### Contract (`protocol.ts`)

Add `export type Worktree = { id: string; path: string; branch: string | null;
sessionCount: number }`. `Project` and `ProjectSummary` are **unchanged** — a
worktree is never persisted, so the stored shapes gain nothing.

### Web UI (nested sidebar)

- `SessionSidebar`: each project row gains an expand/collapse chevron
  (accessible French name, e.g. « Afficher les worktrees »). On first expand, a
  lazy `useQuery({ queryKey: ['worktrees', project.id], queryFn: () =>
  backend.listWorktrees(project.id) })` loads the children. Children render
  indented under the project: branch label (or a short id when detached) +
  `sessionCount`, in the parent's identity color, visually subordinate. A
  project with zero worktrees shows an empty, quiet state when expanded.
  Selecting a worktree calls the existing `onSelectProject(worktreeId)`.
- `App.tsx`: the set of valid workspace ids becomes persisted project ids
  **plus** the worktree ids currently loaded in the sidebar's expanded rows.
  The stale-guard (`:159`, `… ? openProjectId : projects[0]?.id ?? null`) and
  the last-session restore effect (`:199-204`) check membership against that
  combined set, so opening a worktree — and restoring one on launch — is not
  bounced back to `projects[0]`. Everything downstream past the guards
  (`['sessions', workspaceId]`, `controller.open(sessionId, workspaceId)`,
  draft creation, modified-files, model/permission gates) is unchanged once the
  six server sites accept the `wt:` id.
- **URL round-trip.** `wt:` ids travel in route params and query strings.
  base64url is `[A-Za-z0-9_-]` and the `:` is escaped by `encodeURIComponent`
  (→ `%3A`) and decoded by Hono, so the id survives every route that carries
  it — no extra encoding needed.
- `api/client.ts` + `api/backend.ts`: add `listWorktrees(projectId):
  Promise<Worktree[]>` to the client and the `Backend` interface; the fixtures
  backend returns a small realistic set (a couple of worktrees on named
  branches) so nesting is alive in demo mode.

### Behaviour details & edge cases

- **Per-worktree side-state.** Because the `wt:` id is stable across restarts
  (derived from the path), `modelOverrides`, `permissionModes`, drafts, and
  `AlwaysRule.projectId` keyed on it persist correctly and stay isolated per
  worktree — Decision 4. A draft created in a worktree carries the `wt:` id as
  its `projectId` and resolves to the worktree path on its first turn.
- **Removed worktrees.** After `git worktree remove`, the worktree stops being
  discovered (drops out of the sidebar) and any side-map entries keyed on its
  `wt:` id become inert. No garbage collection — harmless, and YAGNI.
- **Refresh.** Worktree lists refetch on window focus and can be refetched on
  demand; agent-created worktrees appear after a refetch / ⌘R.
- **Locked / prunable worktrees** are still listed (they are real cwd targets);
  the `locked` flag is parsed and available but the first cut need not surface
  it in the UI.

## Testing

TDD throughout; whole suite green; `bunx tsc --noEmit` clean on
server/web/desktop; French UI copy.

- **Porcelain parser (most-tested unit).** Fixtures covering: main dir excluded
  (its path equals the project root); a normal branch worktree →
  `branch` without `refs/heads/`; a detached-HEAD worktree → `branch: null`; a
  `locked` worktree → flag set, still returned; a `bare` entry skipped;
  multiple blocks separated by blank lines; malformed/partial trailing block
  tolerated (no throw).
- **`resolveWorkspacePath`.** Persisted project id → its path; a valid `wt:` id
  (path present in a registered project's `git worktree list`, git mocked) →
  the path; a `wt:` id whose decoded path is NOT a worktree of any registered
  project → null; a `wt:` id decoding to a registered project's own root path →
  null (the root is addressed by its project id — the id space stays 1:1);
  an unknown plain id → null.
- **Route (`app.test.ts`, git mocked).** `GET /api/projects/:id/worktrees`
  returns `Worktree[]` with ids, branches, and counts; unknown project → `[]`;
  a project whose `git worktree list` errors → `[]`, never 500; token guard
  enforced.
- **Guards accept `wt:` ids (sites 1–3).** `app.test.ts`: the WS guard
  (`app.ts:66`) returns 101/allows upgrade for a valid `wt:` id and still 400s
  for an unknown/forged one; `GET /projects/:wtId/sessions` returns the
  worktree's sessions (not 404); `POST /projects/:wtId/sessions` creates a
  draft carrying the `wt:` id.
- **Session/stream integration (sites 4–5).** A turn opened on a `wt:` id runs
  with `cwd` = the worktree path (assert via the mock SDK's recorded cwd) using
  the path threaded through `streams.get(id, projectId, workspacePath)`;
  `list(wtId)` returns that worktree's sessions.
- **Broker glob scoping (the security test).** An « always allow Edit » answered
  on a stream constructed for a `wt:` id derives the matcher
  `<worktreePath>/**`, **never `/**`** — asserts Decision 4 and the fix for the
  `?? ''` bug. A matching test for a persisted-project stream guards against
  regression.
- **Delete (site 6).** Deleting a session that lives in a worktree resolves its
  owning dir through the extended `findOwningProject` (worktree paths included
  in the scan); a session in no known workspace → `SessionNotFoundError` → 404.
- **Sidebar RTL (`SessionSidebar.test.tsx`).** Expanding a project fetches and
  renders its worktree children (branch + count) via the injected backend;
  collapsing hides them; selecting a worktree calls `onSelectProject` with the
  `wt:` id; a project with no worktrees expands to a quiet empty state.
- **App integration (`App.test.tsx`).** Selecting a worktree keys the sessions
  query on the `wt:` id and does not get bounced to `projects[0]`; restoring a
  remembered `wt:` id on launch opens it once its worktree row is known.

## Out of scope

- Creating / removing / locking worktrees from Atelier (`git worktree
  add/remove/lock`).
- Per-project or per-worktree GitHub identity and per-project dashboards
  (a separate v0.3 concern; noted but not built).
- Garbage-collecting side-map entries of removed worktrees.
- Surfacing lock/prune status in the UI beyond the parsed flag.
