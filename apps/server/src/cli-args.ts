import { homedir } from 'node:os'
import { join } from 'node:path'

export type ServerArgs = {
  port: number
  token: string
  dataPath: string
  webDist?: string
  watchStdin: boolean
}

/**
 * Pure parsing of the server options — `argv` and `env` are injected so this is
 * testable without touching the process.
 *
 * The token is mandatory (the security model rests on it: loopback bind + Bearer
 * on every /api route), but it accepts two sources — `--token`, which is what the
 * Electron shell passes, and `ATELIER_TOKEN`, which is what makes
 * `bun run dev:server` usable with no arguments. A missing token is an error,
 * never a silent default: a server left open by accident is worse than a crash.
 */
export function parseArgs(argv: string[], env: Record<string, string | undefined>): ServerArgs {
  let port = 4517
  let token: string | undefined
  let dataPath = join(homedir(), '.atelier', 'app-data.json')
  let webDist: string | undefined
  let watchStdin = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' && argv[i + 1]) {
      port = parseInt(argv[++i] as string, 10)
    } else if (arg === '--token' && argv[i + 1]) {
      token = argv[++i] as string
    } else if (arg === '--data' && argv[i + 1]) {
      const raw = argv[++i] as string
      dataPath = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
    } else if (arg === '--web-dist' && argv[i + 1]) {
      webDist = argv[++i] as string
    } else if (arg === '--watch-stdin') {
      watchStdin = true
    }
  }

  // An empty ATELIER_TOKEN (`export ATELIER_TOKEN=`) counts as absent.
  if (token === undefined && env.ATELIER_TOKEN !== undefined && env.ATELIER_TOKEN !== '') {
    token = env.ATELIER_TOKEN
  }

  if (token === undefined || token === '') {
    throw new Error('an auth token is required: pass --token <value> or set ATELIER_TOKEN')
  }

  return { port, token, dataPath, webDist, watchStdin }
}
