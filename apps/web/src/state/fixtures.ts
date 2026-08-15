import { DEFAULT_WIDGETS, MODELS, type AutopilotState, type ChatMessage, type DevServer, type ProjectSummary, type PrSummary, type ServerEvent, type SessionArtifact, type SessionSummary, type WidgetInstance } from '@atelier/shared'

/**
 * Scripted session data — production code, not test-only.
 *
 * Powers component development (replayed through the SessionController) and is
 * the seed of the demo mode (spec: recorded fixtures replayed by a mock
 * backend). Shapes come straight from @atelier/shared.
 */

const MODEL: string = MODELS[0]

export const FIXTURE_PROJECT_ID = 'proj-atelier'
export const FIXTURE_SESSION_ID = 'ses-refresh-token'
export const FIXTURE_DRAFT_ID = 'draft-nouvelle-session'

// sessionCount mirrors fixtureSessions below (1 session + 1 draft) — the REST DTO carries it.
export const fixtureProjects: ProjectSummary[] = [{ id: FIXTURE_PROJECT_ID, path: '/Users/demo/workspace/atelier', color: 'cyan', sessionCount: 2 }]

export const fixtureSessions: SessionSummary[] = [
  {
    id: FIXTURE_SESSION_ID,
    projectId: FIXTURE_PROJECT_ID,
    name: 'Expired refresh token',
    updatedAt: '2026-07-15T09:41:00.000Z',
    messageCount: 5,
    isDraft: false,
    model: MODEL,
    permissionMode: 'default',
  },
  {
    id: FIXTURE_DRAFT_ID,
    projectId: FIXTURE_PROJECT_ID,
    name: null,
    updatedAt: '2026-07-15T09:45:00.000Z',
    messageCount: 0,
    isDraft: true,
    model: MODEL,
    // Unanswered — selecting the demo draft exercises the permissions gate.
    permissionMode: null,
  },
]

/** Persisted history per session — what GET /api/sessions/:id/messages returns. */
export const fixtureMessages: Record<string, ChatMessage[]> = {
  [FIXTURE_SESSION_ID]: [
    {
      role: 'user',
      text: 'Sessions expire after an hour — the refresh token never renews.',
      at: '2026-07-15T09:30:00.000Z',
    },
    { role: 'assistant', text: 'Let me look at the refresh token handling.', at: '2026-07-15T09:30:04.000Z' },
    {
      role: 'tool',
      toolUseId: 'tu-h1',
      kind: 'Read',
      summary: 'src/auth/session.ts',
      ok: true,
      file: 'src/auth/session.ts',
      at: '2026-07-15T09:30:06.000Z',
    },
    {
      role: 'tool',
      toolUseId: 'tu-h2',
      kind: 'Edit',
      summary: 'src/auth/session.ts',
      ok: true,
      file: 'src/auth/session.ts',
      line: 42,
      diffstat: { added: 6, removed: 2 },
      at: '2026-07-15T09:30:20.000Z',
    },
    {
      role: 'assistant',
      text: 'The renewal was short-circuited when `expiresAt` was already past. Fixed: the token now refreshes as soon as fewer than five minutes remain.',
      at: '2026-07-15T09:30:30.000Z',
    },
  ],
  [FIXTURE_DRAFT_ID]: [],
}

/**
 * One realistic live turn for FIXTURE_SESSION_ID: connect snapshot, streamed
 * text, a Bash tool call with its result, a permission prompt, more text,
 * usage, a question prompt (QCM), then idle.
 */
export const fixtureTurn: ServerEvent[] = [
  { type: 'status', sessionId: FIXTURE_SESSION_ID, state: 'streaming' },
  { type: 'assistant_delta', sessionId: FIXTURE_SESSION_ID, text: 'Rerunning the test suite' },
  { type: 'assistant_delta', sessionId: FIXTURE_SESSION_ID, text: ' to verify the fix.' },
  {
    type: 'tool_use',
    sessionId: FIXTURE_SESSION_ID,
    toolUseId: 'tu-l1',
    kind: 'Bash',
    summary: 'bun test src/auth',
  },
  { type: 'tool_result', sessionId: FIXTURE_SESSION_ID, toolUseId: 'tu-l1', ok: true, summary: '18 pass, 0 fail' },
  {
    type: 'permission_request',
    sessionId: FIXTURE_SESSION_ID,
    requestId: 'perm-l1',
    toolName: 'Bash',
    rendered: 'git push origin main',
    proposedRule: { toolName: 'Bash', matcher: 'git push' },
  },
  { type: 'assistant_delta', sessionId: FIXTURE_SESSION_ID, text: 'All tests pass.' },
  { type: 'assistant_delta', sessionId: FIXTURE_SESSION_ID, text: ' Only the branch push remains.' },
  {
    type: 'usage',
    sessionId: FIXTURE_SESSION_ID,
    inputTokens: 2413,
    outputTokens: 486,
    cacheReadTokens: 1820,
    cacheCreationTokens: 0,
  },
  {
    type: 'question_request',
    sessionId: FIXTURE_SESSION_ID,
    requestId: 'fixture-q-1',
    questions: [
      {
        question: 'Which approach do you prefer?',
        header: 'Approach',
        options: [
          { label: 'Dedicated broker', description: 'A separate QuestionBroker, clear semantics' },
          { label: 'Extend the broker', description: 'Fewer files, more guards' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which platforms to target?',
        header: 'Platforms',
        options: [
          { label: 'macOS', description: 'The daily driver' },
          { label: 'Linux', description: 'Maybe someday' },
          { label: 'Windows', description: 'Not a priority' },
        ],
        multiSelect: true,
      },
    ],
  },
  { type: 'status', sessionId: FIXTURE_SESSION_ID, state: 'idle' },
]

/**
 * A turn cut short by the usage limit: the closing status carries
 * { reason, resetAt } exactly as the server's turn_error path emits it —
 * the ErrorBanner's reset-time variant (fixtureTurn already covers usage).
 */
export const fixtureErrorTurn: ServerEvent[] = [
  { type: 'status', sessionId: FIXTURE_SESSION_ID, state: 'streaming' },
  { type: 'assistant_delta', sessionId: FIXTURE_SESSION_ID, text: 'Resuming the analysis of the remaining tests.' },
  {
    type: 'status',
    sessionId: FIXTURE_SESSION_ID,
    state: 'error',
    error: { reason: 'usage_limit', resetAt: '2026-07-15T19:10:00.000Z' },
  },
]

/** Demo PRs — one of each visual state so the widget is fully exercisable offline. */
export const fixturePrs: PrSummary[] = [
  { number: 1281, title: 'PRO-2044 - New filter system', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1281', author: 'alice-dev', state: 'open', updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), branch: 'feat/pro-2044', ci: 'pending', review: 'required' },
  { number: 1280, title: 'Fix - Workspace switcher crash', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1280', author: 'carol-dev', state: 'open', updatedAt: new Date(Date.now() - 5 * 3600_000).toISOString(), branch: 'fix/switcher', ci: 'failed', review: 'changes_requested' },
  { number: 1279, title: 'Draft - Virtualization exploration', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1279', author: 'bob-dev', state: 'draft', updatedAt: new Date(Date.now() - 8 * 3600_000).toISOString(), branch: 'spike/virtualization', ci: null, review: null },
  { number: 1276, title: 'SUP-90 - Fix frozen page after closing clause modal', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1276', author: 'alice-dev', state: 'merged', updatedAt: new Date(Date.now() - 26 * 3600_000).toISOString(), branch: 'fix/sup-90', ci: 'passed', review: 'approved' },
  { number: 1274, title: 'Chore - Update @jsfns', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1274', author: 'bob-dev', state: 'closed', updatedAt: new Date(Date.now() - 30 * 3600_000).toISOString(), branch: 'chore/jsfns', ci: 'passed', review: null },
]

/** Demo layout: the default panels — the PR widget joins in chunk 3 (Task 13). */
export const fixtureWidgets: WidgetInstance[] = [...DEFAULT_WIDGETS, { id: 'fixture-github-prs', type: 'github-prs', span: 2, height: 'M', config: { repo: 'acme-corp/demoapp-frontend', limit: 10 } }]

/** État autopilot de démo (spec 2026-08-05) — un run passé avec les trois issues terminales/actives typiques. */
export const fixtureAutopilot: AutopilotState = {
  run: null,
  items: [
    { issue: 12, title: 'Add the ⌘K shortcut', branch: 'autopilot/12', projectId: 'proj-atelier', repoRoot: '/work/atelier', sessionId: 'fixture-session-1', status: 'pr_opened', prUrl: 'https://github.com/g-grum/atelier/pull/91', startedAt: '2026-08-05T09:00:00Z', endedAt: '2026-08-05T09:18:00Z' },
    { issue: 15, title: 'Fix the composer scrolling', branch: 'autopilot/15', projectId: 'proj-atelier', repoRoot: '/work/atelier', sessionId: 'fixture-session-2', status: 'failed', error: 'the turn ended without an open PR', startedAt: '2026-08-05T09:20:00Z', endedAt: '2026-08-05T09:50:00Z' },
  ],
}

/**
 * Demo artifacts for the session-visuals widget. Fixtures mode cannot serve
 * real image bytes — the widget renders a neutral placeholder on img error.
 */
export const fixtureArtifacts: SessionArtifact[] = [
  { path: 'shots/dashboard.png', addedAt: '2026-08-14T09:12:00.000Z' },
  { path: 'shots/lightbox.png', addedAt: '2026-08-14T09:20:00.000Z' },
  { path: '.atelier/uploads/mockup-home.png', addedAt: '2026-08-14T09:31:00.000Z' },
]

/** Demo dev servers — one killable (vite), one external (Stop hidden). */
export const fixtureDevServers: DevServer[] = [
  { port: 4518, pid: 48213, label: 'vite', command: 'bunx vite --port 4518', killable: true },
  { port: 3010, pid: 47102, label: 'external API', command: 'node api/server.js', killable: false },
]
