import type { DevServer, StatusHubEvent } from '@atelier/shared'
import { isDescendant, labelFor, parseLsofListen, parsePsPairs } from './lsof-lib'

export type DevServerMonitorOpts = {
  /** Injected command runner — real callers spawn lsof/ps; tests return canned output. */
  exec: (cmd: string[]) => Promise<string>
  publish: (event: StatusHubEvent) => void
  /** Injected SIGTERM sender — real callers wrap process.kill. */
  kill: (pid: number) => void
  /** The Atelier server's own pid — never listed, and the killable ancestor. */
  selfPid: number
  /** Scan cadence for start() — tests call scan() directly. */
  intervalMs?: number
}

/** External (non-killable) listeners outside this port range are noise (mDNS, rapportd…) and hidden. */
const DEV_PORT_MIN = 3000
const DEV_PORT_MAX = 9999
/** Rolling window of recent Bash commands used to label generic runtimes. */
const BASH_HISTORY_LIMIT = 50

/**
 * Periodically snapshots local TCP listeners while the dashboard is connected
 * (spec 2026-08-14). A server is `killable` iff it descends from the Atelier
 * server process — i.e. it was spawned by a session. The Atelier server itself
 * never appears; unrelated listeners show read-only when in the dev-port range.
 */
export class DevServerMonitor {
  private recentBash: string[] = []
  private last: DevServer[] = []
  private lastKey = ''
  private timer: ReturnType<typeof setInterval> | null = null
  private clients = 0

  constructor(private readonly opts: DevServerMonitorOpts) {}

  /** Feed of session Bash commands — powers the label heuristic. */
  noteBash(command: string): void {
    this.recentBash.push(command)
    if (this.recentBash.length > BASH_HISTORY_LIMIT) this.recentBash = this.recentBash.slice(-BASH_HISTORY_LIMIT)
  }

  /** Last scan result — the stop route's authorization source. */
  servers(): DevServer[] {
    return [...this.last]
  }

  async scan(): Promise<void> {
    const [lsofOut, psOut] = await Promise.all([
      this.opts.exec(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN']),
      this.opts.exec(['ps', '-axo', 'pid,ppid']),
    ])
    const tree = parsePsPairs(psOut)
    const servers: DevServer[] = []
    for (const entry of parseLsofListen(lsofOut)) {
      if (entry.pid === this.opts.selfPid) continue
      const killable = isDescendant(entry.pid, [this.opts.selfPid], tree)
      if (!killable && (entry.port < DEV_PORT_MIN || entry.port > DEV_PORT_MAX)) continue
      servers.push({
        port: entry.port,
        pid: entry.pid,
        label: labelFor(entry.command, this.recentBash),
        command: entry.command,
        killable,
      })
    }
    const key = JSON.stringify(servers)
    if (key === this.lastKey) return
    this.lastKey = key
    this.last = servers
    this.opts.publish({ type: 'dev_servers_status', servers: [...servers] })
  }

  /** SIGTERM a server seen killable at the last scan. */
  stop(pid: number): 'stopped' | 'forbidden' | 'unknown' {
    const server = this.last.find((s) => s.pid === pid)
    if (server === undefined) return 'unknown'
    if (!server.killable) return 'forbidden'
    this.opts.kill(pid)
    return 'stopped'
  }

  /** First hub client starts the interval; the last one leaving stops it. */
  clientConnected(): void {
    this.clients++
    if (this.timer === null) {
      void this.scan()
      this.timer = setInterval(() => void this.scan(), this.opts.intervalMs ?? 5000)
    }
  }

  clientClosed(): void {
    this.clients = Math.max(0, this.clients - 1)
    if (this.clients === 0 && this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
