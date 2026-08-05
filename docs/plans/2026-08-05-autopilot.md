# Autopilot Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un bouton dans Atelier traite le backlog GitHub (issues labellisées `autopilot`) de façon autonome : un agent par issue, worktree isolé, PR à reviewer.

**Architecture:** Un module serveur `apps/server/src/autopilot/` orchestre : fetch des issues via le proxy `gh` existant, worktree + projet Atelier temporaire par item (le cwd d'une session = `project.path`), session réelle taguée par l'état autopilot, suivi de fin de tour via le hub de statut, vérification de PR, état persisté dans app-data. Widget dashboard « Autopilot » côté web.

**Tech Stack:** Bun (serveur + tests), TypeScript strict, React + Testing Library (web), WS maison, `gh` CLI via GhRun. Style repo : quotes simples, pas de point-virgule, commentaires FR. Gates : `bun test` et `bun node_modules/typescript/bin/tsc --noEmit -p apps/web` (bun absolu : `/Users/demo/.bun/bin/bun` si PATH minimal). PAS de biome.

**Spec normative :** `docs/specs/2026-08-05-autopilot-design.md` — en cas de doute, la spec gagne.

---

## Chunk 1: Fondations serveur (types, store, gh, workspace)

### Task 1: Types partagés autopilot

**Files:**
- Modify: `packages/shared/src/protocol.ts` (fin de fichier, après la section GitHub PRs)
- Test: `packages/shared/src/protocol.test.ts` (créer s'il n'existe pas ; sinon ajouter un describe)

- [ ] **Step 1: Écrire le test qui échoue** — parsing du hub élargi

```ts
import { describe, expect, test } from 'bun:test'
import { parseStatusHubEvent } from './protocol'

describe('parseStatusHubEvent', () => {
  test('accepte session_status (comportement historique)', () => {
    expect(parseStatusHubEvent(JSON.stringify({ type: 'session_status', sessionId: 's1', state: 'idle' })))
      .toEqual({ type: 'session_status', sessionId: 's1', state: 'idle' })
  })
  test('accepte autopilot_status avec un état complet', () => {
    const autopilot = { run: null, items: [] }
    expect(parseStatusHubEvent(JSON.stringify({ type: 'autopilot_status', autopilot })))
      .toEqual({ type: 'autopilot_status', autopilot })
  })
  test('rejette le reste', () => {
    expect(parseStatusHubEvent(JSON.stringify({ type: 'nope' }))).toBeNull()
    expect(parseStatusHubEvent('pas du json')).toBeNull()
  })
})
```

- [ ] **Step 2: Lancer** — `/Users/demo/.bun/bin/bun test packages/shared/src/protocol.test.ts` → FAIL (`parseStatusHubEvent` n'existe pas)

- [ ] **Step 3: Implémentation** — dans `protocol.ts`, nouvelle section après les PrSummary :

```ts
// ── Autopilot (spec 2026-08-05) ──
export type AutopilotItemStatus = 'queued' | 'running' | 'pr_opened' | 'failed'
export type AutopilotRunState = 'running' | 'stopping'
export type AutopilotItem = {
  issue: number
  title: string
  branch: string
  /** Projet Atelier temporaire pointant sur le worktree. */
  projectId: string
  /** Id de session — draft d'abord, ré-écrit avec l'id SDK après matérialisation. */
  sessionId: string
  status: AutopilotItemStatus
  prUrl?: string
  error?: string
  startedAt?: string
  endedAt?: string
}
/** run: null = idle. items = dernier run (remplacés au start suivant). */
export type AutopilotState = {
  run: { state: AutopilotRunState; startedAt: string; maxItems: number; projectId: string } | null
  items: AutopilotItem[]
}
/** Diffusé sur le hub /api/sessions-status à chaque mutation d'état autopilot. */
export type AutopilotStatusEvent = { type: 'autopilot_status'; autopilot: AutopilotState }
export type StatusHubEvent = SessionStatusEvent | AutopilotStatusEvent

export function parseStatusHubEvent(raw: string): StatusHubEvent | null {
  const session = parseSessionStatus(raw)
  if (session !== null) return session
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (v?.type !== 'autopilot_status' || typeof v.autopilot !== 'object' || v.autopilot === null) return null
    return { type: 'autopilot_status', autopilot: v.autopilot as AutopilotState }
  } catch {
    return null
  }
}
```

Ne PAS toucher `parseSessionStatus` ni `SessionStatusEvent` (les consommateurs session existants ne voient rien).

- [ ] **Step 4: Relancer** → PASS. Puis gate complet : `/Users/demo/.bun/bin/bun test` → tout vert.
- [ ] **Step 5: Commit** — `feat(shared): types autopilot + parseStatusHubEvent (hub élargi)`

### Task 2: AppData.autopilot + assainissement au boot

**Files:**
- Modify: `apps/server/src/store/app-data.ts` (AppDataShape L12-26, EMPTY L28-49, constructeur L56-71)
- Test: `apps/server/src/store/app-data.test.ts` (existant — ajouter un describe)

- [ ] **Step 1: Test qui échoue** — persistance + failed-au-boot

```ts
describe('autopilot state', () => {
  test('défaut : run null, items vides', () => {
    const data = new AppData(tmpFile())
    expect(data.get().autopilot).toEqual({ run: null, items: [] })
  })
  test('au chargement, un run non terminé est marqué failed (jamais de reprise aveugle)', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({
      autopilot: {
        run: { state: 'running', startedAt: '2026-08-05T00:00:00Z', maxItems: 3, projectId: 'p1' },
        items: [
          { issue: 1, title: 'a', branch: 'autopilot/1', projectId: 'tp1', sessionId: 's1', status: 'running' },
          { issue: 2, title: 'b', branch: 'autopilot/2', projectId: 'tp2', sessionId: 's2', status: 'queued' },
          { issue: 3, title: 'c', branch: 'autopilot/3', projectId: 'tp3', sessionId: 's3', status: 'pr_opened' },
        ],
      },
    }))
    const data = new AppData(file)
    expect(data.get().autopilot.run).toBeNull()
    const statuses = data.get().autopilot.items.map((i) => i.status)
    expect(statuses).toEqual(['failed', 'failed', 'pr_opened'])
    expect(data.get().autopilot.items[0].error).toContain('serveur')
  })
})
```

(Réutiliser le helper de fichier temporaire du test existant — regarder comment les autres tests d'app-data créent leur chemin.)

- [ ] **Step 2: Lancer** — `/Users/demo/.bun/bin/bun test apps/server/src/store/app-data.test.ts` → FAIL
- [ ] **Step 3: Implémentation**
  - `AppDataShape` : `autopilot: AutopilotState` (import depuis `@atelier/shared`)
  - `EMPTY` : `autopilot: { run: null, items: [] }`
  - Constructeur, après le merge : si `this.data.autopilot.run !== null` → `run = null` et tous les items dont le statut n'est ni `pr_opened` ni `failed` passent `failed` avec `error: 'interrompu par un redémarrage du serveur'` + `endedAt`.
- [ ] **Step 4: Relancer** → PASS. Gate complet `bun test`.
- [ ] **Step 5: Commit** — `feat(server): état autopilot persisté + assainissement failed au boot`

### Task 3: GithubService.listAutopilotIssues + prForBranch (sans cache)

**Files:**
- Modify: `apps/server/src/github/github-service.ts`
- Test: `apps/server/src/github/github-service.test.ts` (copier le pattern fake GhRun existant)

- [ ] **Step 1: Tests qui échouent**

```ts
describe('listAutopilotIssues', () => {
  test('liste les issues ouvertes labellisées autopilot, triées par ancienneté', async () => {
    const run = fakeRun({
      'issue list': { stdout: JSON.stringify([
        { number: 12, title: 'B', createdAt: '2026-08-02T00:00:00Z' },
        { number: 7, title: 'A', createdAt: '2026-08-01T00:00:00Z' },
      ]) },
    })
    const service = new GithubService(run)
    const issues = await service.listAutopilotIssues('g-grum/atelier', 'g-grum')
    expect(issues).toEqual([{ number: 7, title: 'A' }, { number: 12, title: 'B' }])
    // vérifie les args exacts passés à gh
    expect(run.calls).toContainEqual(expect.arrayContaining(['issue', 'list', '-R', 'g-grum/atelier', '--label', 'autopilot', '--state', 'open']))
  })
})
describe('prForBranch', () => {
  test('retourne la première PR de la branche, SANS cache (deux appels = deux exécutions gh)', async () => { /* fake retournant [] puis [pr] ; les DEUX appels touchent gh ; le 2e retourne la pr */ })
  test('null quand aucune PR', async () => { /* stdout '[]' → null */ })
})
```

(Adapter `fakeRun` au helper réel du fichier de test existant — il y en a déjà un pour `listPrs`.)

- [ ] **Step 2: Lancer** → FAIL
- [ ] **Step 3: Implémentation** — deux méthodes publiques, mêmes conventions d'erreur (`GithubError`, messages FR) et de token (`resolveToken`) que `listPrs` :

```ts
/** Issues ouvertes labellisées autopilot, plus ancienne d'abord. AUCUN cache. */
async listAutopilotIssues(repo: string, githubUser: string): Promise<{ number: number; title: string }[]> {
  const token = await this.resolveToken(githubUser)
  const result = await this.run(
    ['issue', 'list', '-R', repo, '--label', 'autopilot', '--state', 'open', '--json', 'number,title,createdAt'],
    { GH_TOKEN: token },
  )
  if (result.exitCode !== 0) throw new GithubError(`gh a échoué pour ${repo} : ${result.stderr.trim() || 'erreur inconnue'}`)
  let raw: { number: number; title: string; createdAt: string }[]
  try { raw = JSON.parse(result.stdout) } catch { throw new GithubError(`réponse gh illisible pour ${repo}`) }
  return raw
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ number, title }) => ({ number, title }))
}

/** PR (tous états) dont la branche est `head`. SANS cache — vérifie une PR toute fraîche. */
async prForBranch(repo: string, branch: string, githubUser: string): Promise<{ number: number; url: string } | null> {
  const token = await this.resolveToken(githubUser)
  const result = await this.run(
    ['pr', 'list', '-R', repo, '--head', branch, '--state', 'all', '--json', 'number,url'],
    { GH_TOKEN: token },
  )
  if (result.exitCode !== 0) throw new GithubError(`gh a échoué pour ${repo} : ${result.stderr.trim() || 'erreur inconnue'}`)
  let raw: { number: number; url: string }[]
  try { raw = JSON.parse(result.stdout) } catch { throw new GithubError(`réponse gh illisible pour ${repo}`) }
  return raw[0] ?? null
}
```

- [ ] **Step 4: Relancer** → PASS. Gate `bun test`.
- [ ] **Step 5: Commit** — `feat(server): GithubService.listAutopilotIssues + prForBranch sans cache`

### Task 4: Workspace runner (worktree + bun install + nettoyage)

**Files:**
- Create: `apps/server/src/autopilot/workspace.ts`
- Test: `apps/server/src/autopilot/workspace.test.ts`

Le `GitRun` partagé (git-remote.ts) a un timeout 5 s — trop court pour `worktree add` + `bun install`. Runner d'exécution dédié, même pattern Bun.spawn que `gh-runner.ts`, timeout 10 min, cwd paramétrable. `bun` = `process.execPath` (le serveur TOURNE sous bun — chemin absolu garanti, immune au PATH minimal).

- [ ] **Step 1: Tests qui échouent** — sur un vrai repo git temporaire (pattern : `mkdtemp` + `git init` + commit initial, voir les tests de `git-remote.test.ts` s'ils font ça ; sinon fake exec injecté) :

```ts
describe('workspace', () => {
  test('prepare crée le worktree .worktrees/autopilot-<n> sur la branche autopilot/<n> puis lance bun install', async () => {
    const calls: string[][] = []
    const exec = async (cmd: string[], cwd: string) => { calls.push([...cmd, `cwd=${cwd}`]); return { stdout: '', stderr: '', exitCode: 0 } }
    const ws = createWorkspace('/repo', exec)
    const { path, branch } = await ws.prepare(42)
    expect(path).toBe('/repo/.worktrees/autopilot-42')
    expect(branch).toBe('autopilot/42')
    expect(calls[0]).toEqual(['git', 'worktree', 'add', '.worktrees/autopilot-42', '-b', 'autopilot/42', 'cwd=/repo'])
    expect(calls[1].slice(0, 2)).toEqual([process.execPath, 'install'])
    expect(calls[1].at(-1)).toBe('cwd=/repo/.worktrees/autopilot-42')
  })
  test('prepare échoue en FR si git échoue', async () => { /* exec exitCode 1, stderr 'boom' → rejet Error message contenant 'worktree' */ })
  test('cleanup enchaîne worktree remove --force puis branch -D, tolère les échecs individuels', async () => { /* vérifier les args et qu'un exitCode 1 sur remove n'empêche pas branch -D */ })
})
```

- [ ] **Step 2: Lancer** → FAIL
- [ ] **Step 3: Implémentation** — interface injectable :

```ts
type Exec = (cmd: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>

export type Workspace = {
  prepare: (issue: number) => Promise<{ path: string; branch: string }>
  cleanup: (issue: number) => Promise<void>
}

export function createWorkspace(repoRoot: string, exec: Exec = defaultExec): Workspace { … }
```

`defaultExec` : `Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })` + timeout 600 000 ms (pattern gh-runner). `prepare` : `git worktree add …` (cwd repoRoot, échec → `Error('création du worktree impossible : ' + stderr)`), puis `[process.execPath, 'install']` (cwd worktree, échec → message FR). `cleanup` : `git worktree remove --force .worktrees/autopilot-<n>` puis `git branch -D autopilot/<n>` — chaque échec loggé (console.error) mais non-fatal.

- [ ] **Step 4: Relancer** → PASS. Gate `bun test`.
- [ ] **Step 5: Commit** — `feat(server): workspace autopilot — worktree + bun install + nettoyage`

## Chunk 2: AutopilotRunner, hub, routes

### Task 5: Hub de statut élargi (publication autopilot_status)

**Files:**
- Modify: `apps/server/src/stream/session-stream.ts` (SessionStreamRegistry L380-459)
- Modify: `apps/server/src/app.ts` (glue WS `/api/sessions-status`, ~L96 — vérifier le typage du sink)
- Test: `apps/server/src/stream/session-stream.test.ts` (describe registre existant)

- [ ] **Step 1: Test qui échoue**

```ts
test('publish diffuse un événement arbitraire du hub à tous les sinks', () => {
  const registry = new SessionStreamRegistry(data, sdk)
  const seen: unknown[] = []
  registry.onStatusConnect((e) => seen.push(e))
  const event = { type: 'autopilot_status' as const, autopilot: { run: null, items: [] } }
  registry.publish(event)
  expect(seen).toContainEqual(event)
})
test('un sink qui lève n'empêche pas les suivants de recevoir publish', () => { /* pattern du test publishStatus existant */ })
```

- [ ] **Step 2: Lancer** — `/Users/demo/.bun/bin/bun test apps/server/src/stream/session-stream.test.ts` → FAIL
- [ ] **Step 3: Implémentation**
  - `statusSinks` retypé `Set<(event: StatusHubEvent) => void>` (import `StatusHubEvent` de `@atelier/shared`)
  - Nouvelle méthode publique `publish(event: StatusHubEvent): void` avec la même garde par-sink que `publishStatus` ; `publishStatus` (privé, inchangé de signature) délègue à `publish`
  - `onStatusConnect`/`onStatusClose` : paramètre retypé `(event: StatusHubEvent) => void` — le snapshot existant reste fait de `session_status` uniquement (l'état autopilot se récupère par GET, pas par snapshot hub)
  - `app.ts` : le sink WS passe tel quel (il fait `ws.send(JSON.stringify(event))`) — vérifier juste que le typage compile
- [ ] **Step 4: Relancer** → PASS. Gate `bun test`.
- [ ] **Step 5: Commit** — `feat(server): hub de statut élargi — publish public typé StatusHubEvent`

### Task 6: Deny AskUserQuestion pour les sessions autopilot

**Files:**
- Modify: `apps/server/src/stream/session-stream.ts` (SessionStreamParams L11-21, constructeur, canUseTool L150-154, SessionStreamRegistry ctor + get)
- Modify: `apps/server/src/index.ts` (construction du registre — brancher le prédicat sur AppData)
- Test: `apps/server/src/stream/session-stream.test.ts`

- [ ] **Step 1: Test qui échoue** — copier le pattern des tests canUseTool existants (fake SDK qui capture le callback) :

```ts
test('AskUserQuestion est refusé net dans une session autopilot (pas de QuestionBroker)', async () => {
  // registre construit avec isAutopilot: (id) => id === 'sdk-1'
  // session dont resolveSessionId → 'sdk-1', tour lancé, canUseTool capturé
  const result = await canUseTool('AskUserQuestion', { questions: [] })
  expect(result).toEqual({ behavior: 'deny', message: 'Session autonome — décide seul et continue.' })
})
test('AskUserQuestion va au QuestionBroker pour une session normale', async () => { /* comportement historique préservé */ })
```

- [ ] **Step 2: Lancer** → FAIL
- [ ] **Step 3: Implémentation**
  - `SessionStreamParams` + `isAutopilot?: (sessionId: string) => boolean` ; le registre le reçoit dans son constructeur (`isAutopilot: (sessionId: string) => boolean = () => false`) et le transmet à chaque `SessionStream`
  - Dans `canUseTool` (runTurn), AVANT le routage QCM :

```ts
if (toolName === 'AskUserQuestion' && this.isAutopilot?.(this.sessionId()) === true) {
  return Promise.resolve({ behavior: 'deny' as const, message: 'Session autonome — décide seul et continue.' })
}
```

  - `index.ts` : `new SessionStreamRegistry(data, sdk, (sessionId) => data.get().autopilot.items.some((i) => data.resolveSessionId(i.sessionId) === sessionId))` — data-driven, pas de cycle registre↔runner
- [ ] **Step 4: Relancer** → PASS. Gate `bun test`.
- [ ] **Step 5: Commit** — `feat(server): deny AskUserQuestion pour les sessions autopilot`

### Task 7: AutopilotRunner (cœur)

**Files:**
- Create: `apps/server/src/autopilot/autopilot-runner.ts`
- Create: `apps/server/src/autopilot/item-prompt.ts`
- Test: `apps/server/src/autopilot/autopilot-runner.test.ts`, `apps/server/src/autopilot/item-prompt.test.ts`

**item-prompt.ts** (pur, trivial à tester) : `buildItemPrompt({ issue, title, body, branch }): string` — consignes : tu es autonome (ne pose AUCUNE question, tranche seul), lis la spec/docs du repo si pertinent, TDD, gates `bun test` + `bun node_modules/typescript/bin/tsc --noEmit -p apps/web`, commits atomiques FR, `git push -u origin <branch>`, `gh pr create --title … --body '… Closes #<n>'`. Test : le prompt contient le numéro, la branche, `Closes #<n>`, la consigne d'autonomie.

**autopilot-runner.ts** — dépendances TOUTES injectées (testable sans réseau ni git) :

```ts
export type AutopilotDeps = {
  data: AppData
  sessions: SessionsService
  streams: SessionStreamRegistry
  github: Pick<GithubService, 'listAutopilotIssues' | 'prForBranch'>
  workspace: Workspace
  /** owner/repo du projet cible — résolu par la route (git-remote), injecté ici. */
  fetchIssueBody: (repo: number | string, issue: number, user: string) => Promise<string>  // gh issue view --json body — ajouter à GithubService (même pattern, sans cache)
  itemTimeoutMs?: number   // défaut 30 * 60_000
  now?: () => number
}

export class AutopilotRunner {
  start(params: { projectId: string; repo: string; githubUser: string; maxItems: number }): void // throw ConflictError si run non-null
  stop(): void   // run → 'stopping' (no-op si idle)
  cleanup(): Promise<void>  // items terminaux : workspace.cleanup puis suppression du projet temporaire
}
```

Comportement (chaque point = un test) :
1. `start` avec un run en cours → `throw new AutopilotConflictError()` ; sinon : persiste `run { state: 'running', … }` + items `queued` (issues slicées à maxItems), `publish({ type: 'autopilot_status', … })` à CHAQUE mutation d'état (helper privé `mutate(fn)` qui fait `data.update` + publish), et lance la boucle en fire-and-forget
2. Par item : `workspace.prepare(n)` → projet temporaire `data.update((d) => d.projects.push({ id: randomUUID(), path, color: '#6366f1' }))` → `sessions.createDraft(tempProjectId, { name: \`Autopilot #\${n}\` })` → `sessions.setPermissionMode(draftId, 'bypassPermissions')` → `item.sessionId = draftId`, status `running` → `streams.get(draftId, tempProjectId).onMessage(JSON.stringify({ type: 'user_message', text: buildItemPrompt(…) }))`
3. Attente de fin : sink posé via `streams.onStatusConnect` au démarrage du run (retiré via `onStatusClose` à la fin) ; à chaque `session_status`, l'item courant matche si `event.sessionId === data.resolveSessionId(item.sessionId)` — et l'item met à jour `item.sessionId` avec l'id résolu (remap draft→SDK, seule voie fiable). `state === 'idle'` → vérifier la PR ; `state === 'error'` → item `failed` immédiat (message d'erreur du snapshot non accessible par le hub : mettre `error: 'la session a terminé en erreur'`) ; si l'erreur de session porte un resetAt (non visible par le hub — décision : sur `error`, TOUJOURS arrêter le run si l'item suivant échouerait pareil ? NON : spec = arrêt du run seulement sur rate limit ; le hub ne transporte pas resetAt, donc lire `data.get().rateLimits` : si une fenêtre a `status === 'rejected'`, arrêter le run proprement, sinon continuer)
4. Vérification PR : `github.prForBranch(repo, branch, user)` → trouvée : item `pr_opened` + `prUrl`, item suivant. Absente : UNE relance — `onMessage(user_message 'Termine : exécute les gates puis ouvre la PR (gh pr create … Closes #<n>).')` ; à l'idle suivant, re-vérifier ; toujours rien → `failed`
5. Timeout 30 min par item (armé au lancement du tour, désarmé à la transition terminale) : `onMessage(JSON.stringify({ type: 'abort' }))` puis item `failed` (`error: 'timeout'`)
6. `stop()` : `run.state = 'stopping'` — l'item courant va au bout de son cycle (y compris relance déjà émise mais pas de NOUVELLE relance), les `queued` restants ne démarrent pas ; fin de boucle → `run = null`, publish
7. Fin de boucle normale (tous items traités) → `run = null`, publish
8. Erreurs par item (workspace.prepare qui lève, gh qui lève) → item `failed` avec le message FR, boucle continue
9. `cleanup()` : pour chaque item terminal, `workspace.cleanup(issue)` puis `data.update` retire le projet temporaire (id `item.projectId`) et l'item de la liste ; publish

**Fakes de test** : fake SessionsService (createDraft → { id: 'd1', … }), fake registry (capture onMessage, expose un `emit(sessionId, state)` pour simuler le hub, `publish` accumulé), fake workspace, fake github. Utiliser des timers contrôlables (`itemTimeoutMs: 50` + attentes courtes) — PAS de vrais setTimeout de 30 min dans les tests.

- [ ] **Step 1..N:** un cycle test-rouge → implémentation → test-vert PAR comportement listé (1 à 9), commits intermédiaires autorisés
- [ ] **Step final: Gate** `bun test` complet → vert
- [ ] **Commit** — `feat(server): AutopilotRunner — boucle séquentielle bornée, PR par item, stop/cleanup`

### Task 8: fetchIssueBody dans GithubService + routes autopilot + wiring

**Files:**
- Modify: `apps/server/src/github/github-service.ts` (+ test) — `issueBody(repo, issue, user)` : `gh issue view <n> -R repo --json body`, sans cache, mêmes erreurs FR
- Create: `apps/server/src/autopilot/autopilot-routes.ts`
- Test: `apps/server/src/autopilot/autopilot-routes.test.ts` (pattern github-routes.test.ts)
- Modify: `apps/server/src/app.ts` (montage) + `apps/server/src/index.ts` (construction runner + workspace + registre avec isAutopilot)

Routes (préfixe `/api` déjà géré par app.ts) :
- `GET /autopilot` → `{ ...data.get().autopilot }` (200)
- `POST /autopilot/start` body `{ projectId, maxItems? }` : projet introuvable → 404 ; `projectGithubAccount(gitRun, project.path)` → repo null → 400 `{ error: 'ce projet n'a pas de remote GitHub' }` ; run en cours (ConflictError) → 409 ; sinon 202. `maxItems` défaut 3, borné 1-10. `githubUser` = `data.get().preferences.githubUser`
- `POST /autopilot/stop` → 202 (idempotent)
- `POST /autopilot/cleanup` → 200

Tests de routes : 404/400/409/202/200 + le start passe bien repo/user au runner (runner fake injecté).

- [ ] **Steps TDD par route** (rouge → vert), puis wiring app.ts/index.ts (le serveur démarre : lancer `bun test apps/server` en entier)
- [ ] **Gate** `bun test` + tsc → vert
- [ ] **Commit** — `feat(server): routes autopilot + issueBody + wiring`

## Chunk 3: Web (widget, Backend, fixtures)

### Task 9: WidgetType 'autopilot' + validation config par type

**Files:**
- Modify: `packages/shared/src/protocol.ts` (WidgetType L183, WidgetInstance.config L185-195, SINGLETON_WIDGET_TYPES L198)
- Modify: `apps/server/src/routes/validate-widgets.ts` (+ test `validate-widgets.test.ts` existant)

- [ ] **Step 1: Tests qui échouent** (validate-widgets.test.ts, copier les cas github-prs) : type `autopilot` accepté en singleton ; config `{ projectId: 'p1', maxItems: 3 }` acceptée ; `maxItems` hors 1-10 refusé ; config `repo` sur un widget autopilot refusée ; deux widgets autopilot refusés
- [ ] **Step 2: Lancer** → FAIL
- [ ] **Step 3: Implémentation**
  - `protocol.ts` : `WidgetType = 'github-prs' | 'rate-limits' | 'modified-files' | 'autopilot'` ; `config?: { repo: string; limit?: number } | { projectId: string; maxItems?: number }` (union — les consommateurs discriminent par `type` du widget) ; `SINGLETON_WIDGET_TYPES` + `'autopilot'`
  - `validate-widgets.ts` : brancher la validation par type — `github-prs` → `{ repo, limit? }` (existant), `autopilot` → `{ projectId: string non vide, maxItems?: 1-10 }`, autres types → config absente
- [ ] **Step 4: Relancer** → PASS. Gate `bun test` + tsc (l'union peut casser PrListWidget/PrConfigDialog : caster via le discriminant `w.type === 'github-prs'` là où ça râle — pas de `as` sauvage).
- [ ] **Step 5: Commit** — `feat(shared,server): widget autopilot — type, singleton, config validée par type`

### Task 10: Seam Backend + client REST + fixtures

**Files:**
- Modify: `apps/web/src/api/backend.ts` (type Backend L17, realBackend L60, createFixtureBackend L99)
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/state/fixtures.ts` (état autopilot de démo)
- Test: le fichier de test existant du backend fixture (chercher `backend.test` ou équivalent — sinon tester via le widget en Task 11)

- [ ] **Step 1: Étendre le type** :

```ts
getAutopilot(): Promise<AutopilotState>
startAutopilot(projectId: string, maxItems?: number): Promise<void>   // 4xx → throw Error(message FR du body)
stopAutopilot(): Promise<void>
cleanupAutopilot(): Promise<void>
```

- `client.ts` : GET/POST correspondants (pattern `getGithubPrs` — même gestion d'erreur `{ error }` → throw)
- Fixtures : `fixtureAutopilot: AutopilotState` avec un run null et 3 items d'exemple (`pr_opened` avec prUrl, `failed` avec error, `running`) ; `createFixtureBackend` : start → bascule le run + premier item running (assez pour la démo), stop/cleanup → mutations simples
- Le socket de statut fixture n'émet PAS d'autopilot_status (refetch au focus suffit en démo)
- [ ] **Step 2: Gate** tsc → toutes les implémentations de Backend compilent
- [ ] **Step 3: Commit** — `feat(web): seam Backend autopilot + fixtures démo`

### Task 11: Widget Autopilot + dialog config + branchement App

**Files:**
- Create: `apps/web/src/components/widgets/AutopilotWidget.tsx` (+ test)
- Create: `apps/web/src/components/widgets/AutopilotConfigDialog.tsx` (+ test — pattern PrConfigDialog : sélecteur de projet + maxItems)
- Modify: `apps/web/src/components/widgets/widget-registry.ts` (WIDGET_META : `autopilot`, singleton, `create()`)
- Modify: `apps/web/src/components/widgets/DashboardGrid.tsx` (~L103 : `onConfigure` aussi pour `autopilot`)
- Modify: `apps/web/src/App.tsx` (renderWidget ~L353 ; hub : passer de `parseSessionStatus` à `parseStatusHubEvent` là où le socket de statut est consommé — sur `autopilot_status`, rafraîchir l'état autopilot ; « ouvrir la session » = réutiliser la sélection de session existante)

Comportements du widget (un test chacun, Testing Library, backend fixture) :
- run null : bouton « Lancer » (désactivé si pas de config projectId) ; run actif : « Arrêter » + état
- liste des items : #issue, titre, badge statut (queued/running/pr_opened/failed), erreur FR affichée sur failed
- lien PR (↗ navigateur système — pattern PrListWidget `openUrl`), lien « session » → sélectionne la session `item.sessionId`
- bouton « Nettoyer » visible si au moins un item terminal ; appelle cleanupAutopilot puis refetch
- erreur backend (throw) → message dans le widget (pattern PrListWidget)
- accent visuel : réutiliser la palette existante (pas d'ambre — réservé aux permissions)

- [ ] **Steps TDD par comportement**, puis gates complets : `bun test` + `bun node_modules/typescript/bin/tsc --noEmit -p apps/web`
- [ ] **Commit** — `feat(web): widget Autopilot — run, items, PR, session, nettoyage`

### Task 12: Vérification E2E réelle (MANUELLE / superviseur — pas de subagent)

- [ ] `bun run build:web` (le widget est servi depuis dist/)
- [ ] Serveur headless isolé : `ATELIER_PORT` libre + `--data` temporaire (pattern QCM v0.1.11) ; créer une issue de test labellisée `autopilot` sur un repo jetable (ou g-grum/atelier avec une issue triviale, ex. « ajouter un fichier docs/test-autopilot.md ») ; `POST /api/autopilot/start` ; observer : worktree créé, bun install, session qui tourne, PR ouverte, item `pr_opened`, hub qui diffuse
- [ ] Vérifier le deny AskUserQuestion (session autonome) et le stop propre
- [ ] Nettoyage : `POST /api/autopilot/cleanup` + fermeture de l'issue de test
- [ ] Commit final + push (CI verte attendue) + release : bumper `version.json` (notes FR)
