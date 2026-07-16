import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { ProjectSummary } from '@atelier/shared'
import type { AppData } from '../store/app-data'
import type { SessionsService } from '../sessions/sessions-service'
import { openInIde, spawnLaunch, type LaunchFn } from '../ide/open-in-ide'
import { readJsonObject } from './read-json'

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
    const windowBudgetTokens = parsed.windowBudgetTokens as number | undefined
    const weeklyBudgetTokens = parsed.weeklyBudgetTokens as number | undefined
    data.update((d) => {
      if (ide !== undefined) d.preferences.ide = ide as typeof d.preferences.ide
      if (defaultModel !== undefined) d.preferences.defaultModel = defaultModel
      if (windowBudgetTokens !== undefined) d.preferences.windowBudgetTokens = windowBudgetTokens
      if (weeklyBudgetTokens !== undefined) d.preferences.weeklyBudgetTokens = weeklyBudgetTokens
    })
    return c.json(data.get().preferences)
  })

  // Usage history — the raw events (4 counters, 7-day retention); the web-side
  // estimator derives the gauges from them. Token-guarded like every /api route.
  app.get('/usage/history', (c) => {
    return c.json(data.get().usageEvents)
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

  return app
}
