import { MODELS, DEFAULT_WIDGETS, type ChatMessage, type ProjectSummary, type ServerEvent, type SessionSummary, type WidgetInstance } from '@atelier/shared'

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
 * usage, then idle.
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
  { type: 'status', sessionId: FIXTURE_SESSION_ID, state: 'idle' },
]

/**
 * A turn cut short by the usage limit: the closing status carries
 * { reason, resetAt } exactly as the server’s turn_error path emits it —
 * the ErrorBanner’s reset-time variant (fixtureTurn already covers usage).
 */
export const fixtureErrorTurn: ServerEvent[] = [
  { type: ‘status’, sessionId: FIXTURE_SESSION_ID, state: ‘streaming’ },
  { type: ‘assistant_delta’, sessionId: FIXTURE_SESSION_ID, text: ‘Je reprends l’analyse des tests restants.’ },
  {
    type: ‘status’,
    sessionId: FIXTURE_SESSION_ID,
    state: ‘error’,
    error: { reason: ‘usage_limit’, resetAt: ‘2026-07-15T19:10:00.000Z’ },
  },
]

/** Demo layout: the default panels — the PR widget joins in chunk 3 (Task 13). */
export const fixtureWidgets: WidgetInstance[] = [...DEFAULT_WIDGETS]
