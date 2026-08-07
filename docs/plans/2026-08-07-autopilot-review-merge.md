# Autopilot niveau 2 (review + auto-merge) — plan d'implémentation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** après `pr_opened`, chaque item autopilot est reviewé par une session agent dédiée (verdict = fichier JSON local), corrigé si besoin (un cycle), puis mergé automatiquement quand la CI est verte.

**Architecture :** extension du `AutopilotRunner` existant (séquentiel, borné, hub de statut) ; verdict via `.worktrees/review-<n>.json` (GitHub refuse la self-review, incognito oblige) ; `GithubService` gagne `prCi` et `mergePr` ; nouveaux statuts d'item `reviewing/fixing/merging/merged`. Spec : `docs/specs/2026-08-07-autopilot-review-merge-design.md` (fait foi).

**Tech stack :** Bun + TypeScript, tests `bun test`, gh CLI via `GhRun`, pas de node sur le PATH (`bun node_modules/typescript/bin/tsc`).

**Gates par tâche :** `bun test <fichiers touchés> > /tmp/t.log; ec=$?` (JAMAIS de pipe direct — il masque l'exit code) puis, en fin de chunk, `bun test` complet + `bun node_modules/typescript/bin/tsc --noEmit -p apps/web`.

**Style :** français (messages, erreurs, commentaires), single quotes sans point-virgule (suivre les voisins), AUCUNE attribution IA dans les commits (mode incognito).

---

## Chunk 1 : types, boot, prédicat QCM

### Task 1 : statuts et champ reviewSessionId (shared)

**Files:**
- Modify: `packages/shared/src/protocol.ts:183-200`

- [ ] **Step 1 : étendre les types**

```ts
export type AutopilotItemStatus = 'queued' | 'running' | 'pr_opened' | 'reviewing' | 'fixing' | 'merging' | 'merged' | 'failed'
```

et dans `AutopilotItem`, après `sessionId` :

```ts
  /** Session de review (niveau 2) — draft d'abord, ré-écrit avec l'id SDK après matérialisation. */
  reviewSessionId?: string
```

- [ ] **Step 2 : vérifier**

Run : `bun node_modules/typescript/bin/tsc --noEmit -p apps/web` et `bun test packages/shared`
Expected : tsc CASSE à coup sûr — `STATUS_LABEL` (AutopilotWidget.tsx:26) est un `Record<AutopilotItem['status'], string>` exhaustif. **Obligatoire** : ajouter dès maintenant les 5 libellés du Chunk 5 Task 10 (`reviewing: 'en review'`, `fixing: 'en correction'`, `merging: 'merge en cours'`, `merged: 'mergée'`, `pr_opened: 'PR ouverte (non mergée)'`) pour garder le repo vert ; les tests widget restent pour Task 10.

- [ ] **Step 3 : commit** `git commit -m "autopilot : statuts review/fix/merge et session de review (types)"`

### Task 2 : boot — merged terminal, nouveaux statuts normalisés

**Files:**
- Modify: `apps/server/src/store/app-data.ts:88` (méthode `sanitizeAutopilot`)
- Test: `apps/server/src/store/app-data.test.ts`

- [ ] **Step 1 : test qui échoue** — items persistés avec run non-null : `merged` doit SURVIVRE au boot, `reviewing`/`fixing`/`merging` doivent devenir `failed` (« interrompu par un redémarrage du serveur »). Suivre le test de sanitisation existant du fichier.

- [ ] **Step 2 : vérifier l'échec** — `merged` est actuellement écrasé en `failed`.

- [ ] **Step 3 : implémentation minimale**

```ts
      if (item.status === 'pr_opened' || item.status === 'failed' || item.status === 'merged') continue
```

- [ ] **Step 4 : vert** — `bun test apps/server/src/store`

- [ ] **Step 5 : commit** `git commit -m "autopilot : merged survit au boot, états de review normalisés en failed"`

### Task 3 : prédicat « session autopilot » couvre la review

**Files:**
- Modify: `apps/server/src/index.ts:64-66`

- [ ] **Step 1 : étendre le prédicat** (pas de test dédié — index.ts n'est pas testé, le comportement l'est via le registre)

```ts
const isAutopilotSession = (sessionId: string): boolean =>
  data.get().autopilot.items.some(
    (i) =>
      (i.sessionId !== '' && data.resolveSessionId(i.sessionId) === sessionId) ||
      (i.reviewSessionId !== undefined && i.reviewSessionId !== '' && data.resolveSessionId(i.reviewSessionId) === sessionId)
  )
```

(dans index.ts c'est une **lambda inline**, 3ᵉ argument du constructeur de `SessionStreamRegistry` (lignes 65-67) — étendre cette lambda sur place, ne pas la nommer)

- [ ] **Step 2 : gates chunk** — `bun test > /tmp/t.log; ec=$?` + tsc apps/web, les deux verts.

- [ ] **Step 3 : commit** `git commit -m "autopilot : le deny QCM couvre la session de review"`

---

## Chunk 2 : GithubService — prCi et mergePr

### Task 4 : prCi (rollup d'une PR, sans cache)

**Files:**
- Modify: `apps/server/src/github/github-service.ts` (+ extraire le mapping CI de `mapPr`)
- Test: `apps/server/src/github/github-service.test.ts`

- [ ] **Step 1 : tests qui échouent** — sur le modèle des tests `prForBranch` existants (fake `GhRun`) :
  - args exacts : `['pr', 'view', '42', '-R', repo, '--json', 'statusCheckRollup']`
  - rollup `[{status:'COMPLETED',conclusion:'SUCCESS'}]` → `'passed'` ; conclusion `FAILURE` → `'failed'` ; status non-COMPLETED → `'pending'` ; `[]` ou `null` → `null`
  - exit ≠ 0 → `GithubError` FR

- [ ] **Step 2 : échec vérifié** puis **Step 3 : implémentation**

Extraire de `mapPr` :

```ts
function mapCi(rollup: { status?: string; conclusion?: string }[] | null | undefined): PrCi {
  const checks = rollup ?? []
  return checks.length === 0 ? null
    : checks.some((c) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR') ? 'failed'
    : checks.some((c) => c.status !== 'COMPLETED') ? 'pending'
    : 'passed'
}
```

(`mapPr` l'utilise), puis :

```ts
  /** État CI d'une PR. SANS cache — sert au poll pré-merge (spec 2026-08-07). */
  async prCi(repo: string, number: number, githubUser: string): Promise<PrCi> {
    const raw = await this.runJson<{ statusCheckRollup?: { status?: string; conclusion?: string }[] | null }>(
      ['pr', 'view', String(number), '-R', repo, '--json', 'statusCheckRollup'],
      repo,
      githubUser,
    )
    return mapCi(raw.statusCheckRollup)
  }
```

- [ ] **Step 4 : vert** — `bun test apps/server/src/github` (les tests `mapPr` existants restent verts)

- [ ] **Step 5 : commit** `git commit -m "github : prCi — état CI d'une PR sans cache"`

### Task 5 : mergePr (squash + suppression branche distante)

**Files:**
- Modify: `apps/server/src/github/github-service.ts`
- Test: `apps/server/src/github/github-service.test.ts`

- [ ] **Step 1 : tests qui échouent** — args `['pr', 'merge', '42', '-R', repo, '--squash', '--delete-branch']`, token épinglé passé en env ; exit ≠ 0 → `GithubError` avec le stderr.

- [ ] **Step 2/3 : implémentation** — PAS `runJson` (gh merge ne rend pas de JSON) :

```ts
  /** Merge squash + suppression de la branche distante (worktree et branche locale restent à cleanup()). */
  async mergePr(repo: string, number: number, githubUser: string): Promise<void> {
    const token = await this.resolveToken(githubUser)
    const result = await this.run(['pr', 'merge', String(number), '-R', repo, '--squash', '--delete-branch'], { GH_TOKEN: token })
    if (result.exitCode !== 0) {
      throw new GithubError(`gh a échoué pour ${repo} : ${result.stderr.trim() || 'erreur inconnue'}`)
    }
  }
```

- [ ] **Step 4 : vert** puis **Step 5 : commit** `git commit -m "github : mergePr — merge squash avec suppression de branche"`

---

## Chunk 3 : prompts et verdict

### Task 6 : quatre prompts purs

**Files:**
- Modify: `apps/server/src/autopilot/item-prompt.ts`
- Test: `apps/server/src/autopilot/item-prompt.test.ts`

- [ ] **Step 1 : tests qui échouent** (un `expect(...).toContain(...)` par élément clé, comme les tests existants) : le prompt de review contient le n° d'issue, `git diff main...HEAD`, les deux gates, `verdictPath`, « ne merge JAMAIS », « aucune trace sur GitHub » ; le fix prompt contient chaque finding ; le re-review contient `verdictPath`.

- [ ] **Step 2/3 : implémentation**

```ts
export type ReviewFinding = { title: string; detail: string }

export function buildReviewPrompt({ issue, title, body, branch, verdictPath }: { issue: number; title: string; body: string; branch: string; verdictPath: string }): string {
  return `Tu es un agent reviewer AUTONOME : ne pose aucune question, tranche seul.

Ta mission : reviewer la PR de la branche ${branch}, qui implémente l'issue #${issue} — « ${title} ».

Description de l'issue :
${body.trim() || '(pas de description)'}

Contexte : tu es dans le worktree de la branche, dépendances installées. La branche par défaut est main.

Méthode :
1. Lis le diff complet : \`git diff main...HEAD\`.
2. Vérifie l'adéquation à l'issue, la cohérence avec les patterns du repo (style, tests voisins, docs/specs pertinentes) et cherche les vrais défauts (bugs, cas limites, tests manquants ou mensongers).
3. Exécute les gates : \`bun test\` et \`bun node_modules/typescript/bin/tsc --noEmit -p apps/web\` — un gate rouge est un finding bloquant.
4. Écris ton verdict — UNIQUEMENT ce fichier, rien d'autre : ${verdictPath}
   Format JSON strict : {"verdict":"approve"} ou {"verdict":"request_changes","findings":[{"title":"…","detail":"…"}]} (findings non vide).

Interdits : committer, pousser, merger, commenter sur GitHub — aucune trace en ligne. Le fichier de verdict est ton SEUL livrable.`
}

export function buildReReviewPrompt(verdictPath: string): string {
  return `Des corrections ont été poussées sur la branche depuis ta review. Re-vérifie : relis \`git diff main...HEAD\`, ré-exécute les gates (\`bun test\` + \`bun node_modules/typescript/bin/tsc --noEmit -p apps/web\`), et réécris ton verdict JSON à ${verdictPath} (mêmes règles, mêmes interdits).`
}

export function buildFixPrompt(findings: ReviewFinding[]): string {
  const list = findings.map((f) => `- ${f.title} : ${f.detail}`).join('\n')
  return `La review de ta PR demande des corrections :

${list}

Corrige chaque point (TDD quand c'est pertinent), exécute les gates (\`bun test\` + \`bun node_modules/typescript/bin/tsc --noEmit -p apps/web\`), puis commite et pousse sur ta branche. Ne merge JAMAIS. Ne touche pas à main.`
}

export function buildRetryVerdictPrompt(verdictPath: string): string {
  return `Il manque ton verdict. Écris le fichier JSON à ${verdictPath} — {"verdict":"approve"} ou {"verdict":"request_changes","findings":[{"title":"…","detail":"…"}]} — c'est ton SEUL livrable.`
}
```

- [ ] **Step 4 : vert** — `bun test apps/server/src/autopilot/item-prompt.test.ts`
- [ ] **Step 5 : commit** `git commit -m "autopilot : prompts de review, correction et verdict"`

### Task 7 : lecture du verdict

**Files:**
- Create: `apps/server/src/autopilot/review-verdict.ts`
- Test: `apps/server/src/autopilot/review-verdict.test.ts`

- [ ] **Step 1 : tests qui échouent** sur `parseVerdict` (pur) :
  - `{"verdict":"approve"}` → `{ verdict: 'approve', findings: [] }`
  - `request_changes` avec findings valides → objet complet
  - `request_changes` sans findings / findings vide / finding sans title → `null`
  - JSON invalide, verdict inconnu, non-objet → `null`
  et sur `readVerdict` (I/O) : fichier absent → `null` (utiliser un chemin sous `/tmp`).

- [ ] **Step 2/3 : implémentation**

```ts
import type { ReviewFinding } from './item-prompt'

export type ReviewVerdict = { verdict: 'approve' | 'request_changes'; findings: ReviewFinding[] }

/** Parse stricte du fichier de verdict (spec 2026-08-07) — tout écart → null (l'appelant relance puis échoue). */
export function parseVerdict(raw: string): ReviewVerdict | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const { verdict, findings } = v as { verdict?: unknown; findings?: unknown }
  if (verdict === 'approve') return { verdict: 'approve', findings: [] }
  if (verdict !== 'request_changes') return null
  if (!Array.isArray(findings) || findings.length === 0) return null
  const parsed: ReviewFinding[] = []
  for (const f of findings) {
    const { title, detail } = (f ?? {}) as { title?: unknown; detail?: unknown }
    if (typeof title !== 'string' || title.length === 0) return null
    parsed.push({ title, detail: typeof detail === 'string' ? detail : '' })
  }
  return { verdict: 'request_changes', findings: parsed }
}

export type ReadVerdict = (path: string) => Promise<ReviewVerdict | null>

export const readVerdict: ReadVerdict = async (path) => {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  return parseVerdict(await file.text())
}

/** Suppression best-effort (avant chaque tour de review, et au cleanup). */
export async function removeVerdict(path: string): Promise<void> {
  try {
    await Bun.file(path).unlink()
  } catch {
    // absent = déjà propre
  }
}
```

- [ ] **Step 4 : vert** puis **Step 5 : commit** `git commit -m "autopilot : lecture stricte du fichier de verdict"`

---

## Chunk 4 : orchestration runner

### Task 8 : review → fix → CI → merge dans AutopilotRunner

**Files:**
- Modify: `apps/server/src/autopilot/autopilot-runner.ts`
- Test: `apps/server/src/autopilot/autopilot-runner.test.ts`

Nouvelles deps (toutes optionnelles ou Pick élargi — suivre le pattern existant) :

```ts
type Deps = {
  // …existant…
  github: Pick<GithubService, 'listAutopilotIssues' | 'prForBranch' | 'issueBody' | 'prCi' | 'mergePr'>
  readVerdict?: ReadVerdict            // défaut : readVerdict du module
  removeVerdict?: (path: string) => Promise<void>
  ciTimeoutMs?: number                 // défaut 20 min
  ciPollMs?: number                    // défaut 30 s
  ciGraceMs?: number                   // défaut 2 min (rollup vide → merge quand même, cf. panne runners GitHub)
}
```

`waitForTurnEnd` généralisé : `waitForTurnEnd(issue, stream, field: 'sessionId' | 'reviewSessionId')` — le waiter lit/réécrit `item[field]` (même logique de remap qu'aujourd'hui). Les appels existants passent `'sessionId'`.

Fin de `processItem` réécrite (à partir de la détection de PR) :

```ts
      if (pr === null) {
        this.updateItem(issue, (i) => {
          i.status = 'failed'
          i.error = 'le tour s’est terminé sans PR ouverte'
          i.endedAt = new Date().toISOString()
        })
        return false
      }
      this.updateItem(issue, (i) => {
        i.status = 'pr_opened'
        i.prUrl = pr.url
      })
      return await this.reviewAndMerge(issue, pr.number, { repo, githubUser, repoRoot, branch, stream, title: item.title, body })
```

Nouvelle méthode (cœur du niveau 2) :

```ts
  /**
   * Review (session dédiée, verdict fichier), un cycle de correction au plus,
   * attente CI puis merge. Retourne true si le RUN doit s'arrêter (rate limit).
   * Toute sortie repose l'item dans un état terminal (merged/failed) ou le
   * laisse en pr_opened (stop — la PR reste mergeable à la main).
   */
  private async reviewAndMerge(
    issue: number,
    prNumber: number,
    ctx: { repo: string; githubUser: string; repoRoot: string; branch: string; stream: { onMessage: (raw: string) => void }; title: string; body: string },
  ): Promise<boolean> {
    if (this.stopRequested(issue)) return false // stop posé pendant le tour d'implémentation : pas de session de review
    const verdictPath = `${ctx.repoRoot}/.worktrees/review-${issue}.json`
    const item = this.getItem(issue)

    // Session de review dédiée — même projet temporaire (même worktree).
    const draft = this.sessions.createDraft(item.projectId, { name: `Review #${issue}` })
    this.sessions.setPermissionMode(draft.id, 'bypassPermissions')
    this.updateItem(issue, (i) => {
      i.status = 'reviewing'
      i.reviewSessionId = draft.id
    })
    const reviewStream = this.streams.get(draft.id, item.projectId)

    let verdict = await this.runReviewTurn(issue, reviewStream, verdictPath,
      buildReviewPrompt({ issue, title: ctx.title, body: ctx.body, branch: ctx.branch, verdictPath }))
    if (verdict === 'turn_failed') return this.lastFailStop
    if (this.stopRequested(issue)) return false
    if (verdict === null) return this.terminalFail(issue, 'la review n’a pas rendu de verdict')

    if (verdict.verdict === 'request_changes') {
      this.updateItem(issue, (i) => {
        i.status = 'fixing'
      })
      ctx.stream.onMessage(JSON.stringify({ type: 'user_message', text: buildFixPrompt(verdict.findings) }))
      const outcome = await this.waitForTurnEnd(issue, ctx.stream, 'sessionId')
      if (outcome !== 'idle') return this.failItem(issue, outcome)
      if (this.stopRequested(issue)) return false

      this.updateItem(issue, (i) => {
        i.status = 'reviewing'
      })
      verdict = await this.runReviewTurn(issue, reviewStream, verdictPath, buildReReviewPrompt(verdictPath))
      if (verdict === 'turn_failed') return this.lastFailStop
      if (this.stopRequested(issue)) return false
      if (verdict === null) return this.terminalFail(issue, 'la review n’a pas rendu de verdict')
      if (verdict.verdict === 'request_changes') return this.terminalFail(issue, 'la review a rejeté la PR après correction')
    }

    return await this.waitCiAndMerge(issue, prNumber, ctx)
  }

  /** Un tour de review : purge du verdict périmé, prompt, fin de tour, lecture ; verdict absent → UNE relance. */
  private async runReviewTurn(
    issue: number,
    reviewStream: { onMessage: (raw: string) => void },
    verdictPath: string,
    prompt: string,
  ): Promise<ReviewVerdict | null | 'turn_failed'> {
    await this.removeVerdict(verdictPath)
    reviewStream.onMessage(JSON.stringify({ type: 'user_message', text: prompt }))
    let outcome = await this.waitForTurnEnd(issue, reviewStream, 'reviewSessionId')
    if (outcome !== 'idle') {
      this.lastFailStop = this.failItem(issue, outcome)
      return 'turn_failed'
    }
    let verdict = await this.readVerdict(verdictPath)
    if (verdict !== null) return verdict
    // Stop posé pendant le tour ? Pas de relance — le stopRequested de l'appelant tranche (avant le check null).
    if (this.data.get().autopilot.run?.state !== 'running') return null
    reviewStream.onMessage(JSON.stringify({ type: 'user_message', text: buildRetryVerdictPrompt(verdictPath) }))
    outcome = await this.waitForTurnEnd(issue, reviewStream, 'reviewSessionId')
    if (outcome !== 'idle') {
      this.lastFailStop = this.failItem(issue, outcome)
      return 'turn_failed'
    }
    return await this.readVerdict(verdictPath)
  }

  /** merging couvre l'attente CI PUIS la commande (spec). stop → retombe en pr_opened. */
  private async waitCiAndMerge(issue: number, prNumber: number, ctx: { repo: string; githubUser: string }): Promise<boolean> {
    this.updateItem(issue, (i) => {
      i.status = 'merging'
    })
    const startedAt = Date.now()
    while (true) {
      if (this.stopRequested(issue)) return false
      const ci = await this.github.prCi(ctx.repo, prNumber, ctx.githubUser)
      if (ci === 'passed') break
      if (ci === 'failed') return this.terminalFail(issue, 'CI rouge sur la PR')
      if (ci === null && Date.now() - startedAt > this.ciGraceMs) break // CI muette (workflows parfois non déclenchés)
      if (Date.now() - startedAt > this.ciTimeoutMs) return this.terminalFail(issue, 'timeout CI')
      await new Promise((r) => setTimeout(r, this.ciPollMs))
    }
    try {
      await this.github.mergePr(ctx.repo, prNumber, ctx.githubUser)
    } catch (err) {
      return this.terminalFail(issue, err instanceof Error ? err.message : String(err))
    }
    this.updateItem(issue, (i) => {
      i.status = 'merged'
      i.endedAt = new Date().toISOString()
    })
    return false
  }

  /** stop() demandé (spec : pendant review/fix → l'item retombe à pr_opened, la PR reste mergeable à la main). */
  private stopRequested(issue: number): boolean {
    if (this.data.get().autopilot.run?.state === 'running') return false
    this.updateItem(issue, (i) => {
      i.status = 'pr_opened'
      i.error = 'run arrêté avant merge'
      i.endedAt = new Date().toISOString()
    })
    return true
  }

  /** failed + endedAt, ne stoppe jamais le run. */
  private terminalFail(issue: number, error: string): boolean {
    this.updateItem(issue, (i) => {
      i.status = 'failed'
      i.error = error
      i.endedAt = new Date().toISOString()
    })
    return false
  }
```

Notes d'implémentation :
- **`cleanup()` (autopilot-runner.ts:88)** : le filtre terminal devient `i.status === 'pr_opened' || i.status === 'failed' || i.status === 'merged'` — sans quoi un item mergé n'est jamais nettoyable (test 12).
- `waitForTurnEnd` généralisé : `item[field]` est `string | undefined` alors que `resolveSessionId` exige un string — utiliser `item[field] ?? ''` (lecture ET ré-écriture) pour rester correct en strict TS.
- `private lastFailStop = false` = champ privé (à déclarer) posé par `runReviewTurn` juste avant de rendre `'turn_failed'` (transporte le « stop run » de `failItem` à travers le retour typé). Alternative acceptée : faire rendre `{ kind: 'failed'; stopRun: boolean }` — au choix de l'implémenteur, mais UNE seule source de vérité.
- Le `endedAt` de `pr_opened` : posé uniquement dans la branche stop (sinon l'item continue).
- L'ancien bloc `updateItem` final de `processItem` (endedAt + pr_opened/failed) DISPARAÎT — remplacé par les transitions ci-dessus.
- Defaults : `DEFAULT_CI_TIMEOUT_MS = 20 * 60_000`, `DEFAULT_CI_POLL_MS = 30_000`, `DEFAULT_CI_GRACE_MS = 2 * 60_000`.
- Imports : `buildFixPrompt, buildReviewPrompt, buildReReviewPrompt, buildRetryVerdictPrompt` depuis `./item-prompt`, `readVerdict as defaultReadVerdict, removeVerdict as defaultRemoveVerdict, type ReviewVerdict` depuis `./review-verdict`.

- [ ] **Step 1 : UN test à la fois (TDD strict), dans cet ordre** — utiliser les fakes existants du fichier de test (hub, github, workspace, sessions) ; ajouter au fake github `prCi`/`mergePr` pilotables et un `readVerdict` fake injecté ; `ciPollMs: 1, ciGraceMs: 5, ciTimeoutMs: 50` dans les tests :
  1. happy path : PR trouvée → item passe `reviewing` (2ᵉ draft « Review #N » créée, bypass) → verdict approve → `merging` → CI passed → mergePr appelé avec le bon n° → `merged`
  2. request_changes → `fixing` (fix prompt CONTENANT les findings envoyé à la session d'implémentation) → tour idle → re-review approve → `merged`
  3. double request_changes → `failed` « la review a rejeté la PR après correction », `prUrl` conservé
  4. verdict absent au 1er tour → prompt de relance envoyé → verdict absent encore → `failed` « la review n’a pas rendu de verdict »
  5. CI `failed` → item `failed` « CI rouge sur la PR » (mergePr JAMAIS appelé)
  6. CI `pending` sans fin → `failed` « timeout CI »
  7. CI `null` (rollup vide) au-delà de la grâce → merge quand même → `merged`
  8. `stop()` pendant l'attente CI → item `pr_opened` avec « run arrêté avant merge », run s'arrête
  9. `stop()` pendant la review (posé avant la fin du tour) → item `pr_opened`, PAS de cycle fix
  10. tour de review en `error` + fenêtre rate-limit rejetée valide → item `failed`, run STOPPÉ (items suivants non traités)
  11. remap draft→SDK de la session de review : le hub émet l'id SDK, `reviewSessionId` réécrit (même mécanique que le test existant sur `sessionId`)
  12. `cleanup()` nettoie AUSSI les items `merged` (worktree + projet + item retirés)

  Note fake : la session de review sera `draft-2` dans le fake sessions (compteur) — les émissions hub des tours de review doivent cibler CET id.

- [ ] **Step 2 : implémentation au fil des tests** (le squelette ci-dessus), chaque test vert avant le suivant.

- [ ] **Step 3 : gates** — `bun test apps/server/src/autopilot > /tmp/t.log; ec=$?` puis `bun test` complet + tsc apps/web.

- [ ] **Step 4 : brancher index.ts** — passer `github` tel quel (le Pick élargi suffit), rien d'autre à injecter (defaults).

- [ ] **Step 5 : commit** `git commit -m "autopilot : review par agent, cycle de correction unique, merge auto sur CI verte"`

### Task 9 : cleanup du fichier de verdict

**Files:**
- Modify: `apps/server/src/autopilot/workspace.ts` (cleanup)
- Test: `apps/server/src/autopilot/workspace.test.ts`

- [ ] **Step 1 : test qui échoue** — `cleanup(7)` exécute aussi `['rm', '-f', '.worktrees/review-7.json']` dans repoRoot (best-effort, échec ignoré comme les autres).
- [ ] **Step 2/3 : implémentation** — ajouter l'exec en fin de `cleanup` (pas de log d'échec : `rm -f` ne râle pas). NE PAS « factoriser » avec `removeVerdict` (review-verdict.ts) : le workspace passe par son seam `exec` (testable par fake), le runner par Bun.file — deux mécanismes voulus.
- [ ] **Step 4 : vert** puis **Step 5 : commit** `git commit -m "autopilot : le nettoyage retire le fichier de verdict"`

---

## Chunk 5 : widget et livraison

### Task 10 : libellés et terminaux du widget

**Files:**
- Modify: `apps/web/src/components/widgets/AutopilotWidget.tsx:29-30,71,118`
- Test: `apps/web/src/components/widgets/AutopilotWidget.test.tsx`

- [ ] **Step 1 : tests qui échouent** — item `merged` affiche « mergée » et compte comme terminal (bouton Nettoyer visible run arrêté) ; `reviewing`/`fixing`/`merging` affichent « en review »/« en correction »/« merge en cours » et ne sont PAS terminaux.

- [ ] **Step 2/3 : implémentation**
  - `STATUS_LABEL` : `reviewing: 'en review'`, `fixing: 'en correction'`, `merging: 'merge en cours'`, `merged: 'mergée'`, et `pr_opened: 'PR ouverte (non mergée)'`
  - extraire `const TERMINAL = new Set<AutopilotItemStatus>(['pr_opened', 'failed', 'merged'])` ; `hasTerminal` l'utilise
  - dot : `merged` → classe `merged` (vert) ; `pr_opened` → `open` ; `failed` → `closed` ; le reste → `open` (ajuster l'expression ligne 118 en conséquence)

- [ ] **Step 4 : vert** — `bun test apps/web/src/components/widgets/AutopilotWidget.test.tsx`
- [ ] **Step 5 : commit** `git commit -m "widget autopilot : états review/merge et merged terminal"`

### Task 11 : gates finaux + validation E2E réelle + release

- [ ] **Step 1 : gates complets** — `bun test > /tmp/t.log; ec=$?` (TOUS verts) + `bun node_modules/typescript/bin/tsc --noEmit -p apps/web`.

- [ ] **Step 2 : E2E réelle** (mêmes précautions que v0.1.13/14, cf. MEMORY) :
  - vérifier port 4517 + jobs avant (parallel-jobs-coordination) ; serveur ISOLÉ : `--port 4890 --token test --data /tmp/autopilot-e2e`
  - préférence `githubUser` du data isolé patchée à `g-grum` ; compte gh ACTIF = `g-grum` pendant le run (`gh auth switch --user g-grum`, RESTAURER `alice-dev` après)
  - créer une issue de test labellisée `autopilot` (petite, vérifiable), lancer un run maxItems 1
  - attendu : PR ouverte → review → (éventuel fix) → CI verte → PR MERGÉE sans intervention ; item `merged` dans le widget ; AUCUNE trace IA sur la PR/commits (incognito)
  - nettoyage : cleanup widget + fermeture issue + suppression du data isolé

- [ ] **Step 3 : release** — bump `version.json` (0.1.15, notes FR concises orientées utilisateur) + `bun run build:web` + commit release.

- [ ] **Step 4 : MEMORY** — mettre à jour l'index mémoire (v0.1.15, verdict fichier, self-review GitHub impossible).
