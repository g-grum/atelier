import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from '../store/app-data'
import { MockSdkClient } from '../sdk/sdk-client.mock'
import { SessionsService } from '../sessions/sessions-service'
import { settingsRoutes } from '../routes/settings-routes'
import { buildCliArgs, buildSchemeUrl, openInIde, type LaunchFn } from './open-in-ide'

const FILE = '/proj/src/app.ts'

/** Launch stub returning scripted results per call, recording every argv. */
function fakeLaunch(results: boolean[]): { launch: LaunchFn; calls: string[][] } {
  const calls: string[][] = []
  const launch: LaunchFn = async (argv) => {
    calls.push(argv)
    return results[calls.length - 1] ?? false
  }
  return { launch, calls }
}

describe('buildSchemeUrl', () => {
  test('webstorm → webstorm://open?file=<abs>&line=<n>', () => {
    expect(buildSchemeUrl('webstorm', FILE, 84)).toBe('webstorm://open?file=/proj/src/app.ts&line=84')
  })

  test('webstorm without line omits &line', () => {
    expect(buildSchemeUrl('webstorm', FILE)).toBe('webstorm://open?file=/proj/src/app.ts')
  })

  test('vscode → vscode://file/<abs>:<line>', () => {
    expect(buildSchemeUrl('vscode', FILE, 84)).toBe('vscode://file/proj/src/app.ts:84')
  })

  test('cursor → cursor://file/<abs>:<line>', () => {
    expect(buildSchemeUrl('cursor', FILE, 84)).toBe('cursor://file/proj/src/app.ts:84')
  })

  test('idea → idea://open?file=<abs>&line=<n>', () => {
    expect(buildSchemeUrl('idea', FILE, 84)).toBe('idea://open?file=/proj/src/app.ts&line=84')
  })

  test('escapes spaces in the path so `open <url>` parses it (webstorm)', () => {
    expect(buildSchemeUrl('webstorm', '/proj/My Project/app.ts', 84)).toBe(
      'webstorm://open?file=/proj/My%20Project/app.ts&line=84',
    )
  })

  test('escapes &, #, % and ? so the URL is not misparsed into the wrong file', () => {
    expect(buildSchemeUrl('webstorm', '/proj/a&b#c%d?e.ts', 5)).toBe(
      'webstorm://open?file=/proj/a%26b%23c%25d%3Fe.ts&line=5',
    )
  })

  test('escapes spaces for vscode while keeping / and : intact', () => {
    expect(buildSchemeUrl('vscode', '/proj/My Project/v1:2.ts', 84)).toBe(
      'vscode://file/proj/My%20Project/v1:2.ts:84',
    )
  })

  test('percent-encodes non-ASCII whitespace as UTF-8 bytes (U+3000, NBSP)', () => {
    // Ideographic space U+3000 → E3 80 80 in UTF-8. A code-unit-based encoder
    // produces %3000 — which decodes as '0' + literal '00': a silently wrong path.
    expect(buildSchemeUrl('webstorm', '/proj/a\u3000b.ts', 1)).toBe(
      'webstorm://open?file=/proj/a%E3%80%80b.ts&line=1',
    )
    // NBSP U+00A0 (option+space on a French Mac keyboard) → C2 A0, not a lone %A0.
    expect(buildSchemeUrl('webstorm', '/proj/a\u00A0b.ts', 1)).toBe(
      'webstorm://open?file=/proj/a%C2%A0b.ts&line=1',
    )
  })

  test('percent-encodes non-ASCII letters instead of passing them through raw', () => {
    expect(buildSchemeUrl('webstorm', '/proj/Développement/app.ts', 2)).toBe(
      'webstorm://open?file=/proj/D%C3%A9veloppement/app.ts&line=2',
    )
  })

  test('percent-encodes + so form-decoding query parsers cannot turn it into a space', () => {
    expect(buildSchemeUrl('webstorm', '/proj/a+b.ts', 3)).toBe(
      'webstorm://open?file=/proj/a%2Bb.ts&line=3',
    )
  })

  test('CLI fallback args keep the raw path (argv needs no URL escaping)', () => {
    expect(buildCliArgs('webstorm', '/proj/My Project/a&b.ts', 84)).toEqual([
      'webstorm',
      '--line',
      '84',
      '/proj/My Project/a&b.ts',
    ])
  })
})

describe('openInIde', () => {
  test('opens the scheme via open <url> and reports ok', async () => {
    const { launch, calls } = fakeLaunch([true])
    const result = await openInIde({ ide: 'webstorm', file: FILE, line: 84, launch })
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([['open', 'webstorm://open?file=/proj/src/app.ts&line=84']])
  })

  test('falls back to the webstorm CLI launcher with --line when the scheme fails', async () => {
    const { launch, calls } = fakeLaunch([false, true])
    const result = await openInIde({ ide: 'webstorm', file: FILE, line: 84, launch })
    expect(result).toEqual({ ok: true })
    expect(calls[1]).toEqual(['webstorm', '--line', '84', FILE])
  })

  test('CLI fallback without line omits --line', () => {
    expect(buildCliArgs('webstorm', FILE)).toEqual(['webstorm', FILE])
  })

  test('vscode CLI fallback uses code --goto <abs>:<line>', () => {
    expect(buildCliArgs('vscode', FILE, 84)).toEqual(['code', '--goto', '/proj/src/app.ts:84'])
  })

  test('reports ok: false with an actionable reason when scheme AND CLI fail', async () => {
    const { launch } = fakeLaunch([false, false])
    const result = await openInIde({ ide: 'webstorm', file: FILE, line: 84, launch })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('JetBrains Toolbox')
  })

  test('unknown IDE preference reports ok: false without launching anything', async () => {
    const { launch, calls } = fakeLaunch([])
    const result = await openInIde({ ide: 'bogus', file: FILE, launch })
    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('POST /open-in-ide route', () => {
  function freshRoutes(launchResults: boolean[]) {
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-ide-')), 'data.json')
    const data = new AppData(filePath)
    const { launch, calls } = fakeLaunch(launchResults)
    const sessions = new SessionsService(new MockSdkClient(), data)
    return { app: settingsRoutes(data, sessions, launch), data, calls }
  }

  test('responds { ok: true } and uses the IDE preference from AppData', async () => {
    const { app, data, calls } = freshRoutes([true])
    data.update((d) => {
      d.preferences.ide = 'vscode'
    })
    const res = await app.request('/open-in-ide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: FILE, line: 84 }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls).toEqual([['open', 'vscode://file/proj/src/app.ts:84']])
  })

  test('responds { ok: false, reason } when the launch fails — not a 500', async () => {
    const { app } = freshRoutes([false, false])
    const res = await app.request('/open-in-ide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: FILE, line: 84 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(typeof body.reason).toBe('string')
  })

  test('malformed JSON body responds { ok: false, reason } — never a 500', async () => {
    const { app, calls } = freshRoutes([true])
    const res = await app.request('/open-in-ide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(typeof body.reason).toBe('string')
    expect(calls).toEqual([])
  })

  test('missing file responds { ok: false, reason } without launching', async () => {
    const { app, calls } = freshRoutes([true])
    const res = await app.request('/open-in-ide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line: 84 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(false)
    expect(calls).toEqual([])
  })

  test('lone UTF-16 surrogate in « file » responds { ok: false, reason } — never a 500', async () => {
    const { app, calls } = freshRoutes([true])
    const res = await app.request('/open-in-ide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Legal JSON: the \ud800 escape decodes to a lone high surrogate, which
      // makes encodeURIComponent throw URIError inside escapePath if it gets through.
      body: '{"file":"/p/\\ud800x.ts","line":3}',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(typeof body.reason).toBe('string')
    expect(calls).toEqual([])
  })

  test('legal JSON bodies that are not objects (null, [], "x", 42, true, {}) all respond { ok: false, reason } — never a 500', async () => {
    // Same class as the lone-surrogate bug: JSON.parse succeeds so the parse
    // guard does not fire, then `body.file` on a null/primitive body throws
    // outside any catch and Hono returns 500.
    const raws = ['null', '[]', '"x"', '42', 'true', '{}']
    for (const raw of raws) {
      const { app, calls } = freshRoutes([true])
      const res = await app.request('/open-in-ide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; reason: string }
      expect(body.ok).toBe(false)
      expect(typeof body.reason).toBe('string')
      expect(calls).toEqual([])
    }
  })

  test('a throwing launch still responds { ok: false, reason } — the route is structurally 500-proof, and the error is logged, not swallowed silently', async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'atelier-ide-')), 'data.json')
    const data = new AppData(filePath)
    const throwing: LaunchFn = async () => {
      throw new Error('boom')
    }
    const app = settingsRoutes(data, new SessionsService(new MockSdkClient(), data), throwing)
    // mockRestore clears recorded calls — capture them in a local array instead.
    const loggedErrors: unknown[][] = []
    const errorLog = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      loggedErrors.push(args)
    })
    let res: Response
    try {
      res = await app.request('/open-in-ide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: FILE, line: 84 }),
      })
    } finally {
      errorLog.mockRestore()
    }
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(typeof body.reason).toBe('string')
    // the outer catch must not be a silent swallow
    expect(loggedErrors.some((args) => args.some((a) => a instanceof Error && a.message === 'boom'))).toBe(true)
  })

  test('relative « file » responds { ok: false, reason } without launching', async () => {
    const { app, calls } = freshRoutes([true])
    const res = await app.request('/open-in-ide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'src/app.ts', line: 84 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toContain('absolu')
    expect(calls).toEqual([])
  })

  test('a "-"-prefixed file is rejected before it can reach the CLI fallback argv as a flag', async () => {
    const { app, calls } = freshRoutes([true])
    const res = await app.request('/open-in-ide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: '--goto=/etc/passwd' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(false)
    expect(calls).toEqual([])
  })

  test('non-positive-integer line values (-3, 1.5, Infinity) are ignored — the file opens without line', async () => {
    const bodies = [
      JSON.stringify({ file: FILE, line: -3 }),
      JSON.stringify({ file: FILE, line: 1.5 }),
      // JSON cannot spell Infinity, but 1e999 parses to it.
      `{"file":"${FILE}","line":1e999}`,
    ]
    for (const raw of bodies) {
      const { app, calls } = freshRoutes([true])
      const res = await app.request('/open-in-ide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(calls).toEqual([['open', 'webstorm://open?file=/proj/src/app.ts']])
    }
  })
})
