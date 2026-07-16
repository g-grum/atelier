import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { AppData } from '../store/app-data'
import { openInIde, spawnLaunch, type LaunchFn } from '../ide/open-in-ide'

// No amber here: the design system reserves amber EXCLUSIVELY for permission prompts (spec).
const COLOR_PALETTE = ['cyan', 'magenta', 'violet', 'mint', 'teal'] as const

export function settingsRoutes(data: AppData, launch: LaunchFn = spawnLaunch): Hono {
  const app = new Hono()

  // Projects
  app.get('/projects', (c) => {
    return c.json(data.get().projects)
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
    return c.json(project, 201)
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
    const ide = parsed.ide as string | undefined
    const defaultModel = parsed.defaultModel as string | undefined
    data.update((d) => {
      if (ide !== undefined) d.preferences.ide = ide as typeof d.preferences.ide
      if (defaultModel !== undefined) d.preferences.defaultModel = defaultModel
    })
    return c.json(data.get().preferences)
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

/**
 * Parses a request body and normalizes it to a plain object — null for
 * malformed JSON AND for any legal non-object JSON value ('null', '[]', '"x"',
 * '42', 'true'), so handlers can 400 instead of TypeError-ing into a 500.
 */
async function readJsonObject(req: { json(): Promise<unknown> }): Promise<Record<string, unknown> | null> {
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return null
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
}
