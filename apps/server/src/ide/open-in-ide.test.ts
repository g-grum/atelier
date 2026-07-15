import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from '../store/app-data'
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
    return { app: settingsRoutes(data, launch), data, calls }
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
})
