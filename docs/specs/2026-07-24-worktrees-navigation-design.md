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
**workspace id** that the same machinery accepts — making the change almost
entirely additive (one shared resolver + one discovery endpoint + sidebar
nesting), with the session/draft/WS/modified-files paths untouched.

## Current state (what exists)

- `Project = { id, path, color }` (persisted, `protocol.ts:24`);
  `ProjectSummary = Project & { sessionCount }` is the REST shape
  (`protocol.ts:26`). Projects are stored in `app-data.json`; worktrees are not
  a concept yet.
- Two places resolve a project id → path and would need to also resolve a
  worktree id: `SessionStream.runTurn` (`session-stream.ts:100`, then
  `cwd: project.path` at `:124`) and `SessionsService.list`
  (`sessions-service.ts:24-27`). `findOwningProject` (`:184`) scans only
  persisted projects — a session that lives in a worktree dir would not be
  found for deletion.
- `AgentSdkClient.listSessions(cwd)` and `deleteSession(sessionId, dir)` take a
  dir; `encodeProjectDir` (`sdk-client.ts:379`) maps a cwd to its
  `~/.claude/projects/<encoded>` folder. Worktree session histories already
  live there under the worktree's encoded path.
- Side-maps in `app-data.json` — `modelOverrides`, `permissionModes`,
  `draftMap`, and `AlwaysRule.projectId` — are all keyed by the workspace id
  (today always a project id). A stable worktree id makes them work unchanged.
- `App.tsx` validates the open workspace against the persisted projects list:
  `projects.some(p => p.id === openProjectId) ? openProjectId : projects[0]?.id`
  (`:144`), and last-session restore checks the same list (`:188`). A worktree
  id is not in that list, so both must learn to accept a currently-known
  worktree id.
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

A single shared helper resolves any workspace id to a filesystem path:

```
resolveWorkspacePath(id): Promise<string | null>
  - id matches a persisted project      → project.path
  - id starts with 'wt:'                 → decode to a path, then VALIDATE it
                                           is a linked worktree of some
                                           registered project (its path appears
                                           in `git worktree list` of a parent);
                                           valid → the path, else → null
  - otherwise                            → null
```

Callers already handle `null`: `SessionStream.runTurn` sets the `unknown
project` error state; `SessionsService.list` throws → `countSessions` maps to
0. The two `projects.find(...)` lookups and `findOwningProject`'s scan are
rewritten in terms of this helper (the scan iterates persisted project paths
**plus** each project's discovered worktree paths, so deleting a session that
lives in a worktree finds its owning dir).

Validation-before-use is the security boundary: the base64 path is never
trusted on its own — it must belong to a registered project's `git worktree
list`. This closes path traversal / arbitrary-cwd escalation via a forged
`wt:` id.

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
  The stale-guard (`:144`) and the last-session restore (`:188`) check
  membership against that combined set, so opening a worktree — and restoring
  one on launch — is not bounced back to `projects[0]`. Everything downstream
  (`['sessions', workspaceId]`, `controller.open(sessionId, workspaceId)`,
  draft creation, modified-files, model/permission gates) is unchanged: a `wt:`
  id is a valid workspace id end to end.
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
  project → null; a `wt:` id decoding to a registered project's own path →
  handled deterministically (null or the project path — pick one and test it);
  an unknown plain id → null.
- **Route (`app.test.ts`, git mocked).** `GET /api/projects/:id/worktrees`
  returns `Worktree[]` with ids, branches, and counts; unknown project → `[]`;
  a project whose `git worktree list` errors → `[]`, never 500; token guard
  enforced.
- **Session/stream integration.** A turn opened on a `wt:` id runs with
  `cwd` = the worktree path (assert via the mock SDK's recorded cwd);
  `list(wtId)` returns that worktree's sessions; deleting a session that lives
  in a worktree resolves its owning dir through the extended
  `findOwningProject`.
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
