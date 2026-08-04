import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { parsePort, resolveRuntime } from './resolve-runtime'
import { readThemeGround } from './theme-ground'

// Thin shell (spec: the desktop unit carries no business logic): generate a
// token, spawn the server, wait for /health, open one window on the served UI.
// Security model: loopback binding + token injected via the initial URL.

const DEV = process.env.ATELIER_DEV === '1'
// ATELIER_PORT overrides the server port (smoke runs on a busy machine).
const SERVER_PORT = parsePort(process.env.ATELIER_PORT, 4517)
const UI_PORT = DEV ? 4518 : SERVER_PORT // dev: Vite serves the SPA on 4518

// Packaged (Atelier.app): runtime.json at the package root records the repo
// root and the absolute bun path — a Dock launch gets a minimal PATH, so a
// bare 'bun' would not resolve. Dev: repo root is three levels up from dist.
const runtime = resolveRuntime(dirname(fileURLToPath(import.meta.url)), {
  readTextFile: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
})
const repoRoot = runtime.mode === 'error' ? null : runtime.repoRoot
const bunPath = runtime.mode === 'error' ? null : runtime.bunPath

const token = randomUUID()

let serverProc: ChildProcess | null = null
let serverStderr = ''
let serverExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
let win: BrowserWindow | null = null

function startServer(): void {
  if (repoRoot === null || bunPath === null) return // unreachable: whenReady exits on runtime error first
  const args = [
    join(repoRoot, 'apps', 'server', 'src', 'index.ts'),
    '--port',
    String(SERVER_PORT),
    '--token',
    token,
    // Garde anti-orphelin : le serveur surveille le pipe stdin et s'éteint si
    // le shell meurt sans passer par quit (SIGKILL, crash) — voir stdin-watchdog.
    '--watch-stdin',
  ]
  // Packaged mode: the server serves the built web app. In dev, Vite does.
  if (!DEV) args.push('--web-dist', join(repoRoot, 'apps', 'web', 'dist'))
  // App-data stays the server default (~/.atelier/app-data.json) unless an
  // explicit override is provided (used by smoke runs to isolate real data).
  if (process.env.ATELIER_DATA) args.push('--data', process.env.ATELIER_DATA)

  // stdin en pipe (pas 'ignore') : c'est le canal de vie du watchdog côté serveur.
  serverProc = spawn(bunPath, args, { cwd: repoRoot, stdio: ['pipe', 'ignore', 'pipe'] })
  serverProc.stderr?.on('data', (chunk: Buffer) => {
    serverStderr = (serverStderr + chunk.toString()).slice(-8192)
  })
  serverProc.on('error', (err) => {
    serverStderr += `\nspawn failed: ${err.message}`
    serverExit = { code: null, signal: null }
  })
  serverProc.on('exit', (code, signal) => {
    serverExit = { code, signal }
  })
}

function stopServer(): void {
  if (serverProc && serverProc.exitCode === null && !serverProc.killed) {
    serverProc.kill()
  }
  serverProc = null
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (serverExit) {
      throw new Error(
        `the server exited before becoming ready (code ${serverExit.code ?? 'none'}, signal ${serverExit.signal ?? 'none'})`
      )
    }
    try {
      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)
      if (res.ok) return
    } catch {
      // Not listening yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`the server did not become healthy within ${timeoutMs}ms`)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: readThemeGround(process.env.ATELIER_DATA ?? join(homedir(), '.atelier', 'app-data.json')), // suit le thème persisté — pas de flash au lancement
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  // External links (PR widget ↗, target="_blank"): open in the system browser,
  // NEVER in a child BrowserWindow. Local (loopback) URLs are denied outright —
  // the app is single-window by design.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.includes('127.0.0.1') && !url.includes('localhost')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  win.on('closed', () => {
    win = null
  })
  void win.loadURL(`http://127.0.0.1:${UI_PORT}/?token=${token}`)
  console.log(`atelier window open on http://127.0.0.1:${UI_PORT}`)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Another instance is running — it will focus its window (second-instance).
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    if (runtime.mode === 'error') {
      dialog.showErrorBox('Atelier — server failed to start', runtime.message)
      app.exit(1)
      return
    }
    startServer()
    try {
      await waitForHealth(15000)
    } catch (err) {
      // Plain error dialog only — the full onboarding screen (claude binary
      // missing / not logged in) is explicitly deferred past v0.1.
      const message = err instanceof Error ? err.message : String(err)
      const detail = serverStderr.trim() || '(no stderr captured)'
      dialog.showErrorBox('Atelier — server failed to start', `${message}\n\n${detail}`)
      stopServer()
      app.exit(1)
      return
    }
    createWindow()

    app.on('activate', () => {
      // macOS: re-open a window when the dock icon is clicked and none exist.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // app.quit() runs through here; app.exit() does NOT (handled explicitly above).
  app.on('quit', () => stopServer())

  // External SIGTERM/SIGINT must exit through the quit path so the server
  // child is never orphaned; process 'exit' is the synchronous last resort.
  process.on('SIGTERM', () => app.quit())
  process.on('SIGINT', () => app.quit())
  process.on('exit', () => stopServer())
}
