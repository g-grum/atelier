import { homedir } from 'node:os'
import { join } from 'node:path'
import { websocket } from 'hono/bun'
import { AppData } from './store/app-data'
import { AgentSdkClient } from './sdk/sdk-client'
import { SessionsService } from './sessions/sessions-service'
import { SessionStreamRegistry } from './stream/session-stream'
import { GithubService } from './github/github-service'
import { createGhRunner } from './github/gh-runner'
import { createApp } from './app'

function parseArgs(): { port: number; token: string; dataPath: string; webDist?: string } {
  const args = Bun.argv.slice(2)
  let port = 4517
  let token: string | undefined
  let dataPath = join(homedir(), '.atelier', 'app-data.json')
  let webDist: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--port' && args[i + 1]) {
      port = parseInt(args[++i] as string, 10)
    } else if (arg === '--token' && args[i + 1]) {
      token = args[++i] as string
    } else if (arg === '--data' && args[i + 1]) {
      const raw = args[++i] as string
      dataPath = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
    } else if (arg === '--web-dist' && args[i + 1]) {
      webDist = args[++i] as string
    }
  }

  if (!token) {
    console.error('Error: --token is required')
    process.exit(1)
  }

  return { port, token, dataPath, webDist }
}

const { port, token, dataPath, webDist } = parseArgs()

const data = new AppData(dataPath)
const sdk = new AgentSdkClient()
const streams = new SessionStreamRegistry(data, sdk)
const sessions = new SessionsService(sdk, data, streams)
const github = new GithubService(createGhRunner())
// Repo root — this file lives at apps/server/src/index.ts; the server runs
// from repo sources (repo-tethered bundle), so the path holds in both modes.
const versionFile = join(import.meta.dir, '..', '..', '..', 'version.json')
const app = createApp({ data, sessions, sdk, streams, token, webDist, versionFile, github })

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: app.fetch,
  websocket,
})

console.log(`atelier server on http://127.0.0.1:${port}`)
