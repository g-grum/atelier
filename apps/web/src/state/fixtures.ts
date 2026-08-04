import { DEFAULT_WIDGETS, MODELS, type ChatMessage, type ProjectSummary, type PrSummary, type ServerEvent, type SessionSummary, type WidgetInstance } from '@atelier/shared'

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
    name: 'Refresh token expiré',
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
      text: 'Les sessions expirent au bout d’une heure — le refresh token ne se renouvelle jamais.',
      at: '2026-07-15T09:30:00.000Z',
    },
    { role: 'assistant', text: 'Je regarde la gestion du refresh token.', at: '2026-07-15T09:30:04.000Z' },
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
      text: 'Le renouvellement était court-circuité quand `expiresAt` était déjà dépassé. Corrigé : le token se rafraîchit dès qu’il reste moins de cinq minutes.',
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
  { type: 'assistant_delta', sessionId: FIXTURE_SESSION_ID, text: 'Je relance la suite de tests' },
  { type: 'assistant_delta', sessionId: FIXTURE_SESSION_ID, text: ' pour vérifier le correctif.' },
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
  { type: 'assistant_delta', sessionId: FIXTURE_SESSION_ID, text: 'Tous les tests passent.' },
  { type: 'assistant_delta', sessionId: FIXTURE_SESSION_ID, text: ' Il ne reste qu’à pousser la branche.' },
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
        question: 'Quelle approche préfères-tu ?',
        header: 'Approche',
        options: [
          { label: 'Broker dédié', description: 'Un QuestionBroker séparé, sémantique claire' },
          { label: 'Étendre le broker', description: 'Moins de fichiers, plus de gardes' },
        ],
        multiSelect: false,
      },
      {
        question: 'Quelles plateformes cibler ?',
        header: 'Plateformes',
        options: [
          { label: 'macOS', description: 'Le daily driver' },
          { label: 'Linux', description: 'Un jour peut-être' },
          { label: 'Windows', description: 'Non prioritaire' },
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
  { type: 'assistant_delta', sessionId: FIXTURE_SESSION_ID, text: 'Je reprends l’analyse des tests restants.' },
  {
    type: 'status',
    sessionId: FIXTURE_SESSION_ID,
    state: 'error',
    error: { reason: 'usage_limit', resetAt: '2026-07-15T19:10:00.000Z' },
  },
]

/** Demo PRs — one of each visual state so the widget is fully exercisable offline. */
export const fixturePrs: PrSummary[] = [
  { number: 1281, title: 'PRO-2044 - Nouveau système de filtres', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1281', author: 'alice-dev', state: 'open', updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), branch: 'feat/pro-2044', ci: 'pending', review: 'required' },
  { number: 1280, title: 'Fix - Workspace switcher crash', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1280', author: 'carol-dev', state: 'open', updatedAt: new Date(Date.now() - 5 * 3600_000).toISOString(), branch: 'fix/switcher', ci: 'failed', review: 'changes_requested' },
  { number: 1279, title: 'Draft - Exploration virtualisation', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1279', author: 'bob-dev', state: 'draft', updatedAt: new Date(Date.now() - 8 * 3600_000).toISOString(), branch: 'spike/virtualization', ci: null, review: null },
  { number: 1276, title: 'SUP-90 - Fix frozen page after closing clause modal', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1276', author: 'alice-dev', state: 'merged', updatedAt: new Date(Date.now() - 26 * 3600_000).toISOString(), branch: 'fix/sup-90', ci: 'passed', review: 'approved' },
  { number: 1274, title: 'Chore - Update @jsfns', url: 'https://github.com/acme-corp/demoapp-frontend/pull/1274', author: 'bob-dev', state: 'closed', updatedAt: new Date(Date.now() - 30 * 3600_000).toISOString(), branch: 'chore/jsfns', ci: 'passed', review: null },
]

/** Demo layout: the default panels — the PR widget joins in chunk 3 (Task 13). */
export const fixtureWidgets: WidgetInstance[] = [...DEFAULT_WIDGETS, { id: 'fixture-github-prs', type: 'github-prs', span: 2, height: 'M', config: { repo: 'acme-corp/demoapp-frontend', limit: 10 } }]
