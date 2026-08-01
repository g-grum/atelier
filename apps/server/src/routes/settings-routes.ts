import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { SESSION_PERMISSION_MODES, THEMES, type ProjectSummary, type SessionPermissionMode, type Theme } from '@atelier/shared'
import type { AppData } from '../store/app-data'
import type { SessionsService } from '../sessions/sessions-service'
import { openInIde, spawnLaunch, type LaunchFn } from '../ide/open-in-ide'
import { readJsonObject } from './read-json'
import { validateWidgets } from './validate-widgets'

// No amber here: the design system reserves amber EXCLUSIVELY for permission prompts (spec).
const COLOR_PALETTE = ['cyan', 'magenta', 'violet', 'mint', 'teal'] as const

export function settingsRoutes(data: AppData, sessions: SessionsService, launch: LaunchFn = spawnLaunch): Hono {
  const app = new Hono()

  // Projects — REST shape is ProjectSummary: the persisted Project enriched with
  // its sessionCount at response time (a derived count is never persisted;
  // countSessions never throws, so one unreadable folder cannot break the list).
  app.get('/projects', async (c) => {
    const summaries: ProjectSummary[] = await Promise.all(
      data.get().projects.map(async (project) => ({ ...project, sessionCount: await sessions.countSessions(project.id) })),
    )
    return c.json(summaries)
  })

  app.post('/projects', async (c) => {
    // JSON.parse also succeeds on 'null', '[]', '"x"', '42', 'true' — property
    // access must survive ANY legal JSON body (`body.path` on null was a 500:
    // same class as the open-in-ide lone-surrogate bug).
    const parsed = await readJsonObject(c.req)
    if (parsed === null) return c.json({ error: 'requête invalide : objet JSON attendu' }, 400)
    if (typeof parsed.path !== 'string' || parsed.path.length === 0) {
      return c.json({ error: 'requête invalide : « path » (chemin du projet) est requis' }, 400)
    }
    const id = randomUUID()
    const { projects } = data.get()
    const color = COLOR_PALETTE[projects.length % COLOR_PALETTE.length] as string
    const project = { id, path: parsed.path, color }
    data.update((d) => {
      d.projects.push(project)
    })
    // Registering an already-populated folder reports its real count right away.
    const summary: ProjectSummary = { ...project, sessionCount: await sessions.countSessions(id) }
    return c.json(summary, 201)
  })

  app.delete('/projects/:id', (c) => {
    const { id } = c.req.param()
    data.update((d) => {
      d.projects = d.projects.filter((p) => p.id !== id)
    })
    return new Response(null, { status: 204 })
  })

  // Preferences
  app.get('/preferences', (c) => {
    return c.json(data.get().preferences)
  })

  app.patch('/preferences', async (c) => {
    // Same body-guard class as POST /projects: any legal JSON body → 4xx, never a 500.
    const parsed = await readJsonObject(c.req)
    if (parsed === null) return c.json({ error: 'requête invalide : objet JSON attendu' }, 400)
    if (parsed.ide !== undefined && typeof parsed.ide !== 'string') {
      return c.json({ error: 'requête invalide : « ide » doit être une chaîne' }, 400)
    }
    if (parsed.defaultModel !== undefined && typeof parsed.defaultModel !== 'string') {
      return c.json({ error: 'requête invalide : « defaultModel » doit être une chaîne' }, 400)
    }
    if (parsed.githubUser !== undefined && typeof parsed.githubUser !== 'string') {
      return c.json({ error: 'requête invalide : « githubUser » doit être une chaîne' }, 400)
    }
    if (parsed.theme !== undefined && !THEMES.includes(parsed.theme as Theme)) {
      return c.json({ error: 'requête invalide : « theme » doit être « dark » ou « light »' }, 400)
    }
    // null = effacer (le gate revient) ; sinon un des SESSION_PERMISSION_MODES. Le pattern
    // `!== undefined` du bloc d'écriture rend le null explicite indispensable (spec 2026-07-31).
    if (
      parsed.defaultPermissionMode !== undefined &&
      parsed.defaultPermissionMode !== null &&
      !SESSION_PERMISSION_MODES.includes(parsed.defaultPermissionMode as SessionPermissionMode)
    ) {
      return c.json({ error: 'requête invalide : « defaultPermissionMode » doit être « default », « bypassPermissions » ou null' }, 400)
    }
    // Calibratable usage budgets (estimates by design — spec « Usage & limits »):
    // optional, but when present they must be strictly positive integers.
    for (const field of ['windowBudgetTokens', 'weeklyBudgetTokens'] as const) {
      const value = parsed[field]
      if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
        return c.json({ error: `requête invalide : « ${field} » doit être un entier strictement positif` }, 400)
      }
    }
    const ide = parsed.ide as string | undefined
    const defaultModel = parsed.defaultModel as string | undefined
    const githubUser = parsed.githubUser as string | undefined
    const windowBudgetTokens = parsed.windowBudgetTokens as number | undefined
    const weeklyBudgetTokens = parsed.weeklyBudgetTokens as number | undefined
    data.update((d) => {
      if (ide !== undefined) d.preferences.ide = ide as typeof d.preferences.ide
      if (defaultModel !== undefined) d.preferences.defaultModel = defaultModel
      if (githubUser !== undefined) d.preferences.githubUser = githubUser
      if (windowBudgetTokens !== undefined) d.preferences.windowBudgetTokens = windowBudgetTokens
      if (weeklyBudgetTokens !== undefined) d.preferences.weeklyBudgetTokens = weeklyBudgetTokens
      if (parsed.theme !== undefined) d.preferences.theme = parsed.theme as Theme
      if (parsed.defaultPermissionMode !== undefined) {
        d.preferences.defaultPermissionMode = parsed.defaultPermissionMode as SessionPermissionMode | null
      }
    })
    return c.json(data.get().preferences)
  })

  // Usage history — the raw events (4 counters, 7-day retention); the web-side
  // estimator derives the gauges from them. Token-guarded like every /api route.
  app.get('/usage/history', (c) => {
    return c.json(data.get().usageEvents)
  })

  // Plan limits — last-known snapshot per window (five_hour, seven_day, …),
  // recorded from SDK rate_limit_events. REAL claude.ai/usage numbers; empty
  // until a turn has reported them (honest-data policy).
  app.get('/usage/limits', (c) => {
    return c.json(Object.values(data.get().rateLimits))
  })

  // Open in IDE — always 200 with { ok } : the web toast consumes `reason`, a 500 would break it.
  app.post('/open-in-ide', async (c) => {
    // Structural never-500 invariant: the ENTIRE handler runs inside this try, so
    // no throw — present or future — can escape to Hono's 500 path. The guards
    // below only exist to give precise reasons; the catch is the contract.
    try {
      let parsed: unknown
      try {
        parsed = await c.req.json()
      } catch {
        return c.json({ ok: false, reason: 'requête invalide : corps JSON attendu' })
      }
      // JSON.parse also succeeds on 'null', '[]', '"x"', '42', 'true' — the parse
      // guard above does not fire, so property access must survive ANY JSON value
      // (`body.file` on null was the 500: same class as the lone-surrogate bug).
      const body: { file?: unknown; line?: unknown } =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
      if (typeof body.file !== 'string' || body.file.length === 0) {
        return c.json({ ok: false, reason: 'requête invalide : « file » (chemin absolu) est requis' })
      }
      if (!body.file.isWellFormed()) {
        // A legal JSON body can carry a lone UTF-16 surrogate (\ud800 escape) that
        // makes encodeURIComponent throw URIError; no real macOS path contains one.
        return c.json({ ok: false, reason: 'requête invalide : « file » contient une séquence UTF-16 mal formée' })
      }
      if (!body.file.startsWith('/')) {
        // Also guarantees a '-'-prefixed value can never reach the CLI fallback argv as a flag.
        return c.json({ ok: false, reason: 'requête invalide : « file » doit être un chemin absolu (commençant par /)' })
      }
      const line = typeof body.line === 'number' && Number.isInteger(body.line) && body.line > 0 ? body.line : undefined
      const result = await openInIde({ ide: data.get().preferences.ide, file: body.file, line, launch })
      return c.json(result)
    } catch (err) {
      // Never-500 contract: swallowed into { ok:false } — but never silently.
      console.error('[settings-routes] /open-in-ide failed:', err)
      return c.json({ ok: false, reason: "erreur inattendue lors de l'ouverture dans l'IDE" })
    }
  })

  // Rules
  app.get('/rules', (c) => {
    return c.json(data.get().rules)
  })

  app.delete('/rules/:id', (c) => {
    const { id } = c.req.param()
    data.update((d) => {
      d.rules = d.rules.filter((r) => r.id !== id)
    })
    return new Response(null, { status: 204 })
  })

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

  return app
}
