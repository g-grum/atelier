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
 * Parsing pur des options du serveur — `argv` et `env` sont injectés pour être
 * testables sans toucher au process.
 *
 * Le token est obligatoire (le modèle de sécurité repose dessus : bind loopback
 * + Bearer sur tout /api), mais il accepte deux sources — `--token` (ce que fait
 * le shell Electron) et `ATELIER_TOKEN` (ce qui rend `bun run dev:server`
 * utilisable sans argument). Absence de token = erreur, jamais de défaut
 * silencieux : un serveur ouvert par accident serait pire qu'un crash.
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

  // Un ATELIER_TOKEN vide (`export ATELIER_TOKEN=`) compte comme absent.
  if (token === undefined && env.ATELIER_TOKEN !== undefined && env.ATELIER_TOKEN !== '') {
    token = env.ATELIER_TOKEN
  }

  if (token === undefined || token === '') {
    throw new Error('un token d’authentification est requis : passe --token <valeur> ou définis ATELIER_TOKEN')
  }

  return { port, token, dataPath, webDist, watchStdin }
}
