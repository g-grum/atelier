import { join } from 'node:path'
import { websocket } from 'hono/bun'
import { parseArgs, type ServerArgs } from './cli-args'
import { AppData } from './store/app-data'
import { AgentSdkClient } from './sdk/sdk-client'
import { SessionsService } from './sessions/sessions-service'
import { SessionStreamRegistry } from './stream/session-stream'
import { GithubService } from './github/github-service'
import { createGhRunner } from './github/gh-runner'
import { createApp } from './app'
import { watchStdin } from './stdin-watchdog'
import { AutopilotRunner } from './autopilot/autopilot-runner'
import { createWorkspace } from './autopilot/workspace'
import { existsSync } from 'node:fs'
import { SessionArtifactsTracker } from './artifacts/session-artifacts'
import { DevServerMonitor } from './devservers/dev-server-monitor'

function readArgs(): ServerArgs {
  try {
    return parseArgs(Bun.argv.slice(2), Bun.env)
  } catch (err) {
    console.error(`Erreur : ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

const { port, token, dataPath, webDist, watchStdin: shouldWatchStdin } = readArgs()

if (shouldWatchStdin) {
  watchStdin(process.stdin, () => {
    console.error('stdin fermé — shell parent disparu, arrêt du serveur')
    process.exit(0)
  })
}

const data = new AppData(dataPath)
const sdk = new AgentSdkClient()
// Trackers spec 2026-08-14 — publish est une closure : `streams` n'existe qu'après,
// mais le hub n'est sollicité qu'au runtime, jamais pendant la composition.
const artifacts = new SessionArtifactsTracker({ publish: (e) => streams.publish(e), fileExists: existsSync })
const devServers = new DevServerMonitor({
  exec: async (cmd) => await new Response(Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' }).stdout).text(),
  publish: (e) => streams.publish(e),
  kill: (pid) => process.kill(pid, 'SIGTERM'),
  selfPid: process.pid,
})
// Prédicat data-driven « session autopilot ? » — pas de cycle registre↔runner (spec 2026-08-05).
const streams = new SessionStreamRegistry(
  data,
  sdk,
  (sessionId) =>
    data.get().autopilot.items.some(
      (i) =>
        (i.sessionId !== '' && data.resolveSessionId(i.sessionId) === sessionId) ||
        (i.reviewSessionId !== undefined && i.reviewSessionId !== '' && data.resolveSessionId(i.reviewSessionId) === sessionId)
    ),
  (sessionId, projectId, toolName, input) => {
    if (toolName === 'Bash') {
      const command = (input as Record<string, unknown> | null)?.command
      if (typeof command === 'string') devServers.noteBash(command)
    }
    const root = data.get().projects.find((p) => p.id === projectId)?.path
    if (root !== undefined) artifacts.onToolUse(sessionId, projectId, root, toolName, input)
  }
)
const sessions = new SessionsService(sdk, data, streams)
const github = new GithubService(createGhRunner())
const autopilot = new AutopilotRunner({ data, sessions, streams, github, workspace: createWorkspace })
// Repo root — this file lives at apps/server/src/index.ts; the server runs
// from repo sources (repo-tethered bundle), so the path holds in both modes.
const versionFile = join(import.meta.dir, '..', '..', '..', 'version.json')
const app = createApp({ data, sessions, sdk, streams, token, webDist, versionFile, github, autopilot, devServers })

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: app.fetch,
  websocket,
})

// En mode `--web-dist` le serveur sert lui-même l'UI : l'URL affichée porte le
// token pour être cliquable telle quelle. En dev l'UI vit sur le serveur Vite
// (4518), qui injecte le token lui-même — on n'annonce alors que l'API.
console.log(
  webDist !== undefined
    ? `atelier prêt → http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
    : `atelier server on http://127.0.0.1:${port} (UI dev : bun run dev:web → http://localhost:4518)`
)
