import { homedir } from 'node:os'
import { join } from 'node:path'
import { websocket } from 'hono/bun'
import { AppData } from './store/app-data'
import { AgentSdkClient } from './sdk/sdk-client'
import { SessionsService } from './sessions/sessions-service'
import { createApp } from './app'

function parseArgs(): { port: number; token: string; dataPath: string } {
  const args = Bun.argv.slice(2)
  let port = 4517
  let token: string | undefined
  let dataPath = join(homedir(), '.atelier', 'app-data.json')

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--port' && args[i + 1]) {
      port = parseInt(args[++i] as string, 10)
    } else if (arg === '--token' && args[i + 1]) {
      token = args[++i] as string
    } else if (arg === '--data' && args[i + 1]) {
      const raw = args[++i] as string
      dataPath = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
    }
  }

  if (!token) {
    console.error('Error: --token is required')
    process.exit(1)
  }

  return { port, token, dataPath }
}

const { port, token, dataPath } = parseArgs()

const data = new AppData(dataPath)
const sdk = new AgentSdkClient()
const sessions = new SessionsService(sdk, data)
const app = createApp({ data, sessions, sdk, token })

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: app.fetch,
  websocket,
})

console.log(`atelier server on http://127.0.0.1:${port}`)
