# Worktrees Navigation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Atelier auto-discover a registered project's git worktrees and let the user open one and chat in it (turns run with `cwd` = the worktree path), navigation-only, worktrees nested under their project in the sidebar.

**Architecture:** A worktree is exposed as a stateless, path-addressable **workspace id** (`wt:` + base64url(path)) that flows through the existing `projectId → path → cwd` machinery. Nothing about worktrees is persisted — they are read live from `git worktree list` (via the existing `GitRun` seam, 60 s cache). One shared async `resolveWorkspacePath(id)` widens the **six** places that turn a workspace id into a path; the validated path is threaded into the synchronous `SessionStream`/`PermissionBroker` constructor so no `git` call ever runs in a constructor.

**Tech Stack:** unchanged (Bun test runner, Hono, `@anthropic-ai/claude-agent-sdk`, React 19 + Tailwind v4, Electron). Reuses `apps/server/src/github/git-remote.ts`'s `GitRun` seam and the `GithubService` cache pattern.

**Spec:** `docs/specs/2026-07-24-worktrees-navigation-design.md` — normative, wins over this plan.

**Conventions (identical to prior milestones):** strict TDD; whole suite `bun test` green (**baseline 471 pass**); `bunx tsc --noEmit` clean on apps/server, apps/web, apps/desktop; commits `feat:|fix:|test:|chore:` + trailer `(no trailer)

---

## File structure (locked decisions)

```
packages/shared/src/protocol.ts          # + Worktree DTO (never persisted)
apps/server/src/worktrees/                # NEW unit, mirrors github/
├─ parse-worktree-list.ts                 # PURE: porcelain text → entries[] (+ test)
├─ workspace-id.ts                        # PURE: wt: id encode/decode/guard (+ test)
├─ worktree-service.ts                    # GitRun + 60s cache, never throws (+ test)
├─ resolve-workspace.ts                   # createWorkspaceResolver(data, worktrees) (+ test)
└─ worktrees-routes.ts                    # GET /projects/:id/worktrees
apps/server/src/stream/session-stream.ts  # thread workspacePath → broker/runTurn; registry.get(id,pid,path)
apps/server/src/sessions/sessions-service.ts  # inject resolver; list + findOwningProject via resolver
apps/server/src/sessions/sessions-routes.ts   # widen GET/POST /projects/:id/sessions guards
apps/server/src/app.ts                    # createApp gains resolver+worktrees; WS guard resolves+threads; mount route
apps/server/src/index.ts                  # construct WorktreeService + resolver; wire
apps/server/src/ide/open-in-ide.test.ts   # sessionsRoutes call-site update (signature gains resolver)
apps/web/src/api/client.ts                # + listWorktrees
apps/web/src/api/backend.ts               # Backend interface + fixtures gain listWorktrees
apps/web/src/components/SessionSidebar.tsx    # expand/collapse chevron + worktree children (+ test)
apps/web/src/App.tsx                      # valid-workspace-id set (projects ∪ loaded worktrees) (+ test)
apps/web/src/styles.css                   # .worktree child row styling
```

**Reuse note:** `GitRun` and `createGitRunner()` already exist in `apps/server/src/github/git-remote.ts` — import them, do NOT create a second git runner.

**Parser/service split (clarifies spec §Discovery):** the pure parser returns ALL porcelain entries (including the main working tree and `bare`); the WorktreeService applies the exclusion policy (drop `bare`, drop `path === projectPath`). This keeps the parser a pure text→struct function.

---

## Chunk 1: Server — pure units (parser + id codec)

### Task 1.1: `Worktree` DTO + porcelain parser

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Create: `apps/server/src/worktrees/parse-worktree-list.ts`
- Test: `apps/server/src/worktrees/parse-worktree-list.test.ts`

- [ ] **Step 1: Add the DTO.** In `protocol.ts`, near `Project`/`ProjectSummary`:

```ts
/** REST shape of GET /api/projects/:id/worktrees. Never persisted — derived live from `git worktree list`. */
export type Worktree = { id: string; path: string; branch: string | null; sessionCount: number }
```

- [ ] **Step 2: Write the failing parser test.** `parse-worktree-list.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { parseWorktreeList, type WorktreeEntry } from './parse-worktree-list'

const PORCELAIN = `worktree /repo
HEAD abcd1234
branch refs/heads/main

worktree /repo/.claude/worktrees/feature-x
HEAD ef567890
branch refs/heads/gg/feature-x

worktree /repo/.claude/worktrees/detached-one
HEAD 11112222
detached

worktree /repo/.claude/worktrees/locked-one
HEAD 33334444
branch refs/heads/wt-locked
locked

worktree /repo/bare-thing
bare
`

describe('parseWorktreeList', () => {
  test('parses every block with path, branch, flags', () => {
    const entries = parseWorktreeList(PORCELAIN)
    expect(entries).toEqual([
      { path: '/repo', branch: 'main', locked: false, bare: false },
      { path: '/repo/.claude/worktrees/feature-x', branch: 'gg/feature-x', locked: false, bare: false },
      { path: '/repo/.claude/worktrees/detached-one', branch: null, locked: false, bare: false },
      { path: '/repo/.claude/worktrees/locked-one', branch: 'wt-locked', locked: true, bare: false },
      { path: '/repo/bare-thing', branch: null, locked: false, bare: true },
    ] satisfies WorktreeEntry[])
  })

  test('strips refs/heads/ prefix only', () => {
    const [e] = parseWorktreeList('worktree /a\nHEAD x\nbranch refs/heads/feat/nested\n')
    expect(e?.branch).toBe('feat/nested')
  })

  test('empty input → []', () => {
    expect(parseWorktreeList('')).toEqual([])
  })

  test('malformed trailing block does not throw', () => {
    expect(() => parseWorktreeList('worktree /a\nHEAD')).not.toThrow()
  })
})
```

- [ ] **Step 3: Run — must FAIL.** `bun test apps/server/src/worktrees/parse-worktree-list.test.ts` → module not found.

- [ ] **Step 4: Implement the pure parser.** `parse-worktree-list.ts`:

```ts
export type WorktreeEntry = { path: string; branch: string | null; locked: boolean; bare: boolean }

/**
 * Parse `git worktree list --porcelain`. Blocks are separated by a blank line;
 * each starts with `worktree <path>`, then attribute lines (`HEAD`, `branch`,
 * `detached`, `bare`, `locked`, `prunable`). Pure and total — never throws.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  const flush = () => {
    if (current !== null) entries.push(current)
    current = null
  }
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length).trim(), branch: null, locked: false, bare: false }
    } else if (current === null) {
      continue
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
    }
    // HEAD, detached, prunable: ignored (branch stays null when detached)
  }
  flush()
  return entries
}
```

- [ ] **Step 5: Run — PASS.** `bun test apps/server/src/worktrees/parse-worktree-list.test.ts`. Then `bunx tsc --noEmit` (server + shared).

- [ ] **Step 6: Commit** `feat: worktree porcelain parser and Worktree DTO`.

### Task 1.2: Workspace-id codec

**Files:**
- Create: `apps/server/src/worktrees/workspace-id.ts`
- Test: `apps/server/src/worktrees/workspace-id.test.ts`

- [ ] **Step 1: Failing test.** `workspace-id.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { encodeWorktreeId, decodeWorktreeId, isWorktreeId } from './workspace-id'

describe('workspace-id', () => {
  const path = '/Users/x/workspace/demoapp-frontend/.claude/worktrees/feat one'
  test('round-trips an absolute path', () => {
    const id = encodeWorktreeId(path)
    expect(id.startsWith('wt:')).toBe(true)
    expect(isWorktreeId(id)).toBe(true)
    expect(decodeWorktreeId(id)).toBe(path)
  })
  test('id is deterministic', () => {
    expect(encodeWorktreeId(path)).toBe(encodeWorktreeId(path))
  })
  test('base64url is URL-safe (no + / =)', () => {
    expect(encodeWorktreeId(path)).not.toMatch(/[+/=]/)
  })
  test('isWorktreeId false for a UUID', () => {
    expect(isWorktreeId('ea72ec55-5c1e-4855-94f8-2a9140df806c')).toBe(false)
  })
  test('decodeWorktreeId returns null for a non-wt id', () => {
    expect(decodeWorktreeId('ea72ec55-5c1e')).toBeNull()
  })
  test('decodeWorktreeId returns null for malformed base64', () => {
    expect(decodeWorktreeId('wt:@@@not-base64@@@')).toBeNull()
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** `workspace-id.ts`:

```ts
export const WT_PREFIX = 'wt:'

export function isWorktreeId(id: string): boolean {
  return id.startsWith(WT_PREFIX)
}

export function encodeWorktreeId(absolutePath: string): string {
  return WT_PREFIX + Buffer.from(absolutePath, 'utf8').toString('base64url')
}

/** Decode a `wt:` id back to its path; null for a non-wt id or malformed payload. */
export function decodeWorktreeId(id: string): string | null {
  if (!isWorktreeId(id)) return null
  const payload = id.slice(WT_PREFIX.length)
  // base64url alphabet only; reject anything else so a forged id fails closed.
  if (!/^[A-Za-z0-9_-]*$/.test(payload)) return null
  const decoded = Buffer.from(payload, 'base64url').toString('utf8')
  return decoded.length > 0 ? decoded : null
}
```

- [ ] **Step 4: Run — PASS.** tsc server clean.

- [ ] **Step 5: Commit** `feat: worktree workspace-id codec`.

---

## Chunk 2: Server — discovery service + resolver

### Task 2.1: WorktreeService (git shell + cache, never throws)

**Files:**
- Create: `apps/server/src/worktrees/worktree-service.ts`
- Test: `apps/server/src/worktrees/worktree-service.test.ts`

- [ ] **Step 1: Failing test.** Inject a fake `GitRun` (same seam as `git-remote.ts`). `worktree-service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { GitRun } from '../github/git-remote'
import { WorktreeService } from './worktree-service'

const OUT = `worktree /repo
HEAD a
branch refs/heads/main

worktree /repo/.claude/worktrees/feat
HEAD b
branch refs/heads/gg/feat
`

function fakeGit(result: { stdout?: string; stderr?: string; exitCode?: number }, calls: string[][] = []): GitRun {
  return async (args, cwd) => {
    calls.push([cwd, ...args])
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0 }
  }
}

describe('WorktreeService', () => {
  test('lists linked worktrees, excludes the main dir and bare', async () => {
    const svc = new WorktreeService(fakeGit({ stdout: OUT }))
    const list = await svc.list('/repo')
    expect(list).toEqual([{ path: '/repo/.claude/worktrees/feat', branch: 'gg/feat', locked: false }])
  })

  test('non-git folder / git error → [] (never throws)', async () => {
    const svc = new WorktreeService(fakeGit({ exitCode: 128, stderr: 'not a git repository' }))
    expect(await svc.list('/nope')).toEqual([])
  })

  test('caches within TTL — one git call for two list()s', async () => {
    const calls: string[][] = []
    let t = 1000
    const svc = new WorktreeService(fakeGit({ stdout: OUT }, calls), () => t)
    await svc.list('/repo')
    t = 1000 + 59_000
    await svc.list('/repo')
    expect(calls.length).toBe(1)
    t = 1000 + 61_000
    await svc.list('/repo')
    expect(calls.length).toBe(2)
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** `worktree-service.ts` (mirror `GithubService`: injected runner + `now` + `Map` cache):

```ts
import type { GitRun } from '../github/git-remote'
import { parseWorktreeList } from './parse-worktree-list'

const CACHE_TTL_MS = 60_000

/** A linked worktree of a project (the main working dir and bare entries are excluded). */
export type Worktree = { path: string; branch: string | null; locked: boolean }

export class WorktreeService {
  private readonly cache = new Map<string, { at: number; worktrees: Worktree[] }>()

  constructor(
    private readonly run: GitRun,
    private readonly now: () => number = Date.now,
  ) {}

  /** Linked worktrees for a project path. Never throws — a non-git folder yields []. */
  async list(projectPath: string): Promise<Worktree[]> {
    const hit = this.cache.get(projectPath)
    if (hit !== undefined && this.now() - hit.at < CACHE_TTL_MS) return hit.worktrees

    const result = await this.run(['worktree', 'list', '--porcelain'], projectPath)
    const worktrees =
      result.exitCode !== 0
        ? []
        : parseWorktreeList(result.stdout)
            .filter((e) => !e.bare && e.path !== projectPath)
            .map((e) => ({ path: e.path, branch: e.branch, locked: e.locked }))
    this.cache.set(projectPath, { at: this.now(), worktrees })
    return worktrees
  }

  /** Test/refresh hook: drop a project's cached entry so the next list() re-shells git. */
  invalidate(projectPath: string): void {
    this.cache.delete(projectPath)
  }
}
```

Note the name clash: this module's internal `Worktree` (path/branch/locked) is distinct from the protocol `Worktree` DTO (id/path/branch/sessionCount). Keep the service type local (not exported into the web contract); the route maps service → DTO.

- [ ] **Step 4: Run — PASS.** tsc server clean.

- [ ] **Step 5: Commit** `feat: worktree discovery service with 60s cache`.

### Task 2.2: `resolveWorkspacePath` — the shared resolver

**Files:**
- Create: `apps/server/src/worktrees/resolve-workspace.ts`
- Test: `apps/server/src/worktrees/resolve-workspace.test.ts`

- [ ] **Step 1: Failing test.** Build an `AppData` in a temp file (see existing `app-data.test.ts` for the pattern) with two projects; inject a fake-git `WorktreeService`. `resolve-workspace.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { AppData } from '../store/app-data'
import { WorktreeService } from './worktree-service'
import { encodeWorktreeId } from './workspace-id'
import { createWorkspaceResolver } from './resolve-workspace'
import type { GitRun } from '../github/git-remote'

const WT = '/repo/.claude/worktrees/feat'
const OUT = `worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree ${WT}\nHEAD b\nbranch refs/heads/feat\n`

function build(tmp: string) {
  const data = new AppData(tmp)
  data.update((d) => {
    d.projects = [{ id: 'proj-1', path: '/repo', color: 'cyan' }]
  })
  const git: GitRun = async () => ({ stdout: OUT, stderr: '', exitCode: 0 })
  const resolve = createWorkspaceResolver(data, new WorktreeService(git))
  return { resolve }
}

describe('resolveWorkspacePath', () => {
  test('persisted project id → its path', async () => {
    const { resolve } = build(`/tmp/rw-${Math.random().toString(36).slice(2)}.json`)
    expect(await resolve('proj-1')).toBe('/repo')
  })
  test('valid wt: id (a linked worktree of a registered project) → its path', async () => {
    const { resolve } = build(`/tmp/rw-${Math.random().toString(36).slice(2)}.json`)
    expect(await resolve(encodeWorktreeId(WT))).toBe(WT)
  })
  test('wt: id for a path that is not a worktree of any registered project → null', async () => {
    const { resolve } = build(`/tmp/rw-${Math.random().toString(36).slice(2)}.json`)
    expect(await resolve(encodeWorktreeId('/somewhere/else'))).toBeNull()
  })
  test('wt: id decoding to a project root → null (use the project id for the root)', async () => {
    const { resolve } = build(`/tmp/rw-${Math.random().toString(36).slice(2)}.json`)
    expect(await resolve(encodeWorktreeId('/repo'))).toBeNull()
  })
  test('unknown plain id → null', async () => {
    const { resolve } = build(`/tmp/rw-${Math.random().toString(36).slice(2)}.json`)
    expect(await resolve('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** `resolve-workspace.ts`:

```ts
import type { AppData } from '../store/app-data'
import type { WorktreeService } from './worktree-service'
import { decodeWorktreeId, isWorktreeId } from './workspace-id'

/** Resolve any workspace id (persisted project id OR `wt:` worktree id) to a filesystem path, or null. */
export type WorkspaceResolver = (id: string) => Promise<string | null>

export function createWorkspaceResolver(data: AppData, worktrees: WorktreeService): WorkspaceResolver {
  return async (id) => {
    if (!isWorktreeId(id)) {
      return data.get().projects.find((p) => p.id === id)?.path ?? null
    }
    const path = decodeWorktreeId(id)
    if (path === null) return null
    // Trust anchor: the decoded path must be a LINKED worktree of some
    // registered project. `worktrees.list` excludes each project's own root,
    // so a wt: id decoding to a project root fails here (use the project id).
    for (const project of data.get().projects) {
      const list = await worktrees.list(project.path)
      if (list.some((w) => w.path === path)) return path
    }
    return null
  }
}
```

- [ ] **Step 4: Run — PASS.** tsc server clean.

- [ ] **Step 5: Commit** `feat: workspace-id resolver (projects + validated worktrees)`.

---

## Chunk 3: Server — thread the validated path (sites 1, 4, broker)

### Task 3.1: Thread `workspacePath` into SessionStream + PermissionBroker

**Files:**
- Modify: `apps/server/src/stream/session-stream.ts` (`SessionStreamParams`, constructor, `runTurn`, `SessionStreamRegistry.get`)
- Test: `apps/server/src/stream/session-stream.test.ts`

**Goal of this task:** the stream no longer looks a project up by id; it receives an already-resolved `workspacePath` and uses it for both the SDK `cwd` and the broker's `projectDir`. This fixes the `/**` glob bug for worktrees.

- [ ] **Step 1: Failing tests** in `session-stream.test.ts`:
  - (a) A stream constructed with `workspacePath: '/repo/.claude/worktrees/feat'` runs a turn with `cwd = '/repo/.claude/worktrees/feat'` (assert the mock SDK's recorded `cwd` — see how existing tests read `MockSdkClient` calls).
  - (b) **Security:** an « always allow Edit » derived on that stream produces `proposedRule.matcher === '/repo/.claude/worktrees/feat/**'` — NOT `/**`. (Trigger a permission request for `Edit`; read the broadcast `permission_request.proposedRule`.)
  - (c) Regression: a stream with `workspacePath` = a normal project path still derives `<projectPath>/**`.

- [ ] **Step 2: Run — FAIL** (constructor does not accept `workspacePath`).

- [ ] **Step 3: Implement.**
  - `SessionStreamParams`: add `workspacePath: string`.
  - Constructor: replace `const projectDir = data.get().projects.find((p) => p.id === projectId)?.path ?? ''` with `const projectDir = this.workspacePath` (store `workspacePath` from params first), and keep `new PermissionBroker(data, projectId, projectDir, …)`.
  - `runTurn`: delete the `projects.find` lookup and its `unknown project` early-return; use `cwd: this.workspacePath`. Add a defense-in-depth guard re-based on the threaded path:

```ts
if (!this.workspacePath) {
  this.state = 'error'
  this.lastError = { reason: `unknown workspace: ${this.projectId}` }
  this.broadcast(this.snapshot())
  return
}
```

  - `SessionStreamRegistry.get(id, projectId, workspacePath: string)`: add the param and pass it into `new SessionStream({ …, workspacePath })`.

- [ ] **Step 4: Run — PASS.** Fix any other in-suite callers of `streams.get(...)` / `new SessionStream(...)` the compiler flags (tests). `bunx tsc --noEmit` server clean.

- [ ] **Step 5: Commit** `fix: scope permission globs to the worktree path (no more /**)`.

### Task 3.2: WS guard resolves and threads the path (site 1)

**Files:**
- Modify: `apps/server/src/app.ts` (`createApp` signature + WS guard + upgrade handler)
- Test: `apps/server/src/app.test.ts`

- [ ] **Step 1: Failing tests** in `app.test.ts`:
  - The WS upgrade guard accepts `?projectId=<valid wt: id>` (does not 400). (The suite already exercises the guard for projects — mirror it with a resolvable wt: id; inject a fake-git `WorktreeService` / resolver through `createApp`.)
  - It still 400s for an unresolvable/forged `wt:` id and for a missing projectId.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**
  - `createApp` params: add `resolveWorkspace: WorkspaceResolver` and `worktrees: WorktreeService` (needed by the route in Task 4.1). Update the destructured type.
  - Type the `api` Hono to carry the stashed path: `const api = new Hono<{ Variables: { workspacePath: string } }>()`.
  - WS guard: replace the projects check with the resolver:

```ts
async (c, next) => {
  const projectId = c.req.query('projectId')
  const path = projectId ? await resolveWorkspace(projectId) : null
  if (!projectId || path === null) {
    return c.json({ error: `unknown projectId: ${projectId ?? ''}` }, 400)
  }
  c.set('workspacePath', path)
  await next()
},
```

  - Upgrade handler: `const stream = streams.get(c.req.param('id') ?? '', c.req.query('projectId') as string, c.get('workspacePath'))`.

- [ ] **Step 4: Run — PASS.** tsc server clean.

- [ ] **Step 5: Commit** `feat: accept worktree ids on the session WS stream`.

---

## Chunk 4: Server — sessions routes/service (sites 2, 3, 5, 6) + discovery route

### Task 4.1: Discovery route `GET /api/projects/:id/worktrees`

**Files:**
- Create: `apps/server/src/worktrees/worktrees-routes.ts`
- Modify: `apps/server/src/app.ts` (mount the route), `apps/server/src/index.ts` (construct + wire)
- Test: `apps/server/src/app.test.ts`

- [ ] **Step 1: Failing tests** in `app.test.ts` (inject a fake-git WorktreeService via `createApp`):
  - `GET /api/projects/:id/worktrees` for a registered project returns `Worktree[]` (`{ id: wt:…, path, branch, sessionCount }`), token-guarded.
  - An unknown project id → `[]` (not 500).
  - A project whose git errors → `[]`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** `worktrees-routes.ts`:

```ts
import { Hono } from 'hono'
import type { Worktree } from '@atelier/shared'
import type { AppData } from '../store/app-data'
import type { SessionsService } from '../sessions/sessions-service'
import type { WorktreeService } from './worktree-service'
import { encodeWorktreeId } from './workspace-id'

export function worktreesRoutes(data: AppData, worktrees: WorktreeService, sessions: SessionsService): Hono {
  const app = new Hono()
  app.get('/projects/:id/worktrees', async (c) => {
    const project = data.get().projects.find((p) => p.id === c.req.param('id'))
    if (!project) return c.json([] satisfies Worktree[])
    const list = await worktrees.list(project.path)
    const enriched: Worktree[] = await Promise.all(
      list.map(async (w) => {
        const id = encodeWorktreeId(w.path)
        return { id, path: w.path, branch: w.branch, sessionCount: await sessions.countSessions(id) }
      }),
    )
    return c.json(enriched)
  })
  return app
}
```

  In `app.ts`: `api.route('/', worktreesRoutes(data, worktrees, sessions))`.
  In `index.ts`:

```ts
import { createGitRunner } from './github/git-remote'
import { WorktreeService } from './worktrees/worktree-service'
import { createWorkspaceResolver } from './worktrees/resolve-workspace'
// …
const worktrees = new WorktreeService(createGitRunner())
const resolveWorkspace = createWorkspaceResolver(data, worktrees)
const sessions = new SessionsService(sdk, data, streams, resolveWorkspace)   // 4th param added in Task 4.2
const app = createApp({ data, sessions, sdk, streams, token, webDist, versionFile, github, worktrees, resolveWorkspace })
```

- [ ] **Step 4: Run — PASS.** tsc server clean.

- [ ] **Step 5: Commit** `feat: worktrees discovery endpoint`.

### Task 4.2: Widen session routes + service resolution (sites 2, 3, 5, 6)

**Files:**
- Modify: `apps/server/src/sessions/sessions-service.ts` (constructor gains resolver; `list` + `findOwningProject`/`delete`)
- Modify: `apps/server/src/sessions/sessions-routes.ts` (GET/POST guards)
- Modify: `apps/server/src/app.ts` (pass resolver into `sessionsRoutes`)
- Modify: `apps/server/src/ide/open-in-ide.test.ts` (call-site of `sessionsRoutes`, if any) and any `new SessionsService(...)` test call-sites (add the resolver arg)
- Test: `apps/server/src/sessions/sessions-service.test.ts`, `apps/server/src/app.test.ts`

- [ ] **Step 1: Failing tests.**
  - Service (`sessions-service.test.ts`): `list(wtId)` returns the worktree's SDK sessions (MockSdkClient keyed on the worktree path); `countSessions(wtId)` counts them; a worktree with an unresolvable id → `list` throws / `countSessions` → 0. Deleting a session that lives in a worktree resolves its owning dir (extend the delete test: seed the session under a worktree path, assert `sdk.deleteSession` is called with the worktree path).
  - Routes (`app.test.ts`): `GET /api/projects/:wtId/sessions` → 200 for a resolvable wt id (not 404); `POST /api/projects/:wtId/sessions` → 201; both → 404 for an unresolvable id.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**
  - `SessionsService` constructor: add `private readonly resolveWorkspace: WorkspaceResolver` as the 4th param.
  - `list(id)`: replace `const project = projects.find((p) => p.id === projectId); if (!project) throw …` and `sdk.listSessions(project.path)` with:

```ts
const path = await this.resolveWorkspace(projectId)
if (path === null) throw new Error(`Unknown workspace: ${projectId}`)
const sdkSessions = await this.sdk.listSessions(path)
```

  (`countSessions` already wraps `list` in try/catch → 0.)
  - `findOwningProject(sdkId)` → rename to `findOwningDir(sdkId): Promise<string | undefined>`, scanning persisted project paths **plus** each project's worktree paths (via the injected `WorktreeService` — add it, or resolve through the resolver by encoding worktree ids). Simplest: inject `WorktreeService` too and iterate `[project.path, ...(await worktrees.list(project.path)).map(w => w.path)]`. Update `delete` to use the returned dir path directly in `sdk.deleteSession(sdkId, dir)`.
  - `sessions-routes.ts`: `sessionsRoutes(data, sessions, resolveWorkspace)`; in GET and POST replace `data.get().projects.find(...)` / 404 with:

```ts
if ((await resolveWorkspace(id)) === null) return c.json({ error: 'Not found' }, 404)
```

  - `app.ts`: `api.route('/', sessionsRoutes(data, sessions, resolveWorkspace))`.
  - Fix compiler-flagged call-sites in `open-in-ide.test.ts` and any test constructing `SessionsService`/`sessionsRoutes` (add the resolver; build one from a fake-git `WorktreeService` + the test `AppData`).

- [ ] **Step 4: Run — PASS** (whole `bun test apps/server`). tsc server clean.

- [ ] **Step 5: Commit** `feat: resolve worktree ids across session routes and deletion`.

---

## Chunk 5: Web — client seam + nested sidebar + App integration

### Task 5.1: Web client seam — `listWorktrees`

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/api/backend.ts`
- Test: existing backend/fixtures tests (extend), tsc

- [ ] **Step 1: Failing test/typecheck.** Add `listWorktrees(projectId)` to the `Backend` interface (`backend.ts`) — tsc fails until the typed client and fixtures implement it. Add a fixtures test asserting the fixtures backend returns a couple of worktrees for a known project id.

- [ ] **Step 2: Implement.**
  - `client.ts`: `listWorktrees(projectId: string): Promise<Worktree[]>` → `GET /api/projects/${encodeURIComponent(projectId)}/worktrees` (mirror `listProjects`).
  - `backend.ts`: add to the `Backend` interface; the real backend delegates to the client; the fixtures backend returns e.g. `[{ id: 'wt:...', path: '…/worktrees/feat', branch: 'gg/feat', sessionCount: 2 }]` for the demo project and `[]` otherwise.

- [ ] **Step 3: Run — PASS** (`bun test apps/web`), tsc web clean.

- [ ] **Step 4: Commit** `feat: web client listWorktrees seam`.

### Task 5.2: Nested worktrees in the sidebar

**Files:**
- Modify: `apps/web/src/components/SessionSidebar.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/src/components/SessionSidebar.test.tsx`

- [ ] **Step 1: Failing RTL tests.** (a) Each project row has an expand control (French accessible name, e.g. « Afficher les worktrees ») — clicking it fetches (via the injected backend) and renders worktree children showing branch + `sessionCount`; (b) clicking a worktree child calls `onSelectProject` with the child's `wt:` id; (c) a project with no worktrees expands to a quiet empty state; (d) collapsing hides the children. Inject `listWorktrees` through the same seam the sidebar already uses for its data (props/backend) — do NOT hit the network in tests.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Add a collapsed-by-default expand toggle per project row. On expand, a lazy `useQuery(['worktrees', project.id], () => backend.listWorktrees(project.id))`. Render children indented under the row: branch label (fallback to a short id when `branch === null`) + `.count`. Children use the parent's identity color, visually subordinate (dimmed). Selecting a child calls `onSelectProject(worktree.id)`. Add `.worktree` / `.worktree-name` styles in `styles.css` consistent with existing `.project-*` rules. Keep amber out (permissions only).

- [ ] **Step 4: Run — PASS** (`bun test apps/web`), tsc web clean.

- [ ] **Step 5: Commit** `feat: nested worktrees in the sidebar`.

### Task 5.3: App accepts worktree ids as valid workspaces

**Files:**
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Failing tests** in `App.test.tsx`. (a) Selecting a worktree (calling `onSelectProject` with a `wt:` id that is among the loaded worktrees) keys the sessions query on that `wt:` id and is NOT bounced to `projects[0]` by the stale-guard (`App.tsx:159`); (b) restoring a remembered `wt:` id on launch opens it once its worktree row is known (the restore membership check, `App.tsx:199-204`, accepts it). Provide the loaded worktrees to the test via the backend seam.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Maintain the set of valid workspace ids = persisted project ids **plus** the worktree ids currently loaded in expanded sidebar rows (App already owns the projects query; add the loaded-worktree ids — e.g. lift the sidebar's worktree query results, or track selected/expanded worktree ids in App state). Change the stale-guard (`:159`) and the restore membership check (`:203`) to test membership against that combined set instead of `projects.some(...)`. Everything downstream (`['sessions', workspaceId]`, `controller.open`, draft creation) already takes the id verbatim — no further change.

- [ ] **Step 4: Run — PASS** (whole `bun test`), tsc ×3 clean, `bun run build:web`.

- [ ] **Step 5: Commit** `feat: open and restore worktree workspaces`.

---

## Chunk 6: Acceptance pass on real demoapp-frontend worktrees

### Task 6.1: Live acceptance

- [ ] **Concurrent-write guard first:** `lsof -nP -iTCP:4517 -sTCP:LISTEN`. The daily-driver app is a whole-file writer on `~/.atelier/app-data.json`. If it is running, run this pass against a temp COPY (`cp ~/.atelier/app-data.json /tmp/acc.json`) with `--data /tmp/acc.json` on a FREE port (`ATELIER_PORT`/`--port`), and NEVER touch 4517. See the parallel-jobs memory.
- [ ] With the packaged server (`--web-dist`, temp token, free port, temp data with `demoapp-frontend` registered): `GET /api/projects/:id/worktrees` for demoapp-frontend returns its real worktrees (`git worktree list` shows ~8 under `.claude/worktrees/`), each with a branch and a real `sessionCount`; verify a couple of `wt:` ids decode to the right paths.
- [ ] Open a worktree via the UI (or drive the API): `GET /api/projects/:wtId/sessions` loads that worktree's real `~/.claude` sessions; messages of one old session render. NO real SDK turn needed (the turn path is unchanged and already validated) — do not spend tokens. Optionally, verify the broker glob on a dry `Edit` permission is `<worktreePath>/**` (unit test already covers this; skip live if it would cost a turn).
- [ ] v0.1/v0.2 regression surface: whole suite green (≥ 471 + new tests), `bunx tsc --noEmit` ×3 clean, `bun run build:web` OK, `bun run package:mac` still builds and the packaged app launches on a free port.
- [ ] Fix whatever the pass surfaces (TDD for logic), tick this chunk, **commit** `chore: worktrees acceptance pass complete`.

---

## Execution notes

- Chunks strictly ordered; tasks within a chunk ordered. One subagent per task, two-stage review (spec then quality) per superpowers:subagent-driven-development.
- The pure units (parser, id codec, resolver) are the most-tested; the broker glob-scoping test (Task 3.1 step 1b) is a **security** regression guard — do not let it be dropped.
- A live Atelier instance may occupy port 4517 (owner uses the app daily). Never kill it; test servers pick free ports.
- Reuse `github/git-remote.ts`'s `GitRun` — do not add a second git runner.
