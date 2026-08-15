import { describe, expect, test } from 'bun:test'
import type { StatusHubEvent } from '@atelier/shared'
import { DevServerMonitor } from './dev-server-monitor'

const LSOF = `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
bun     100 g   11u  IPv4 0x1 0t0 TCP *:4517 (LISTEN)
node    300 g   23u  IPv4 0x2 0t0 TCP 127.0.0.1:5173 (LISTEN)
python  400 g    9u  IPv4 0x3 0t0 TCP 127.0.0.1:3010 (LISTEN)
rapportd 900 g   5u  IPv4 0x4 0t0 TCP *:49152 (LISTEN)
`
// Tree: 100 (Atelier server, self) → 200 (session shell) → 300 (vite). 400 & 900 unrelated.
const PS = `  PID  PPID
  100     1
  200   100
  300   200
  400     1
  900     1
`

function makeMonitor(outputs: { lsof?: string; ps?: string } = {}) {
  const published: StatusHubEvent[] = []
  const killed: number[] = []
  const monitor = new DevServerMonitor({
    exec: async (cmd) => (cmd[0] === 'lsof' ? (outputs.lsof ?? LSOF) : (outputs.ps ?? PS)),
    publish: (event) => published.push(event),
    kill: (pid) => killed.push(pid),
    selfPid: 100,
  })
  return { monitor, published, killed }
}

describe('DevServerMonitor', () => {
  test('scan publishes killable descendants and in-range externals, never itself or noise ports', async () => {
    const { monitor, published } = makeMonitor()
    monitor.noteBash('bunx vite --port 5173')
    await monitor.scan()
    expect(published).toEqual([
      {
        type: 'dev_servers_status',
        servers: [
          { port: 5173, pid: 300, label: 'vite', command: 'node', killable: true },
          { port: 3010, pid: 400, label: 'python', command: 'python', killable: false },
        ],
      },
    ])
  })

  test('identical consecutive scans publish only once', async () => {
    const { monitor, published } = makeMonitor()
    await monitor.scan()
    await monitor.scan()
    expect(published).toHaveLength(1)
  })

  test('a change re-publishes', async () => {
    const outputs = { lsof: LSOF }
    const { monitor, published } = makeMonitor(outputs)
    await monitor.scan()
    outputs.lsof = LSOF.replace('127.0.0.1:5173', '127.0.0.1:5174')
    await monitor.scan()
    expect(published).toHaveLength(2)
  })

  test('stop: SIGTERMs a killable pid, refuses non-killable, unknown pid reported', async () => {
    const { monitor, killed } = makeMonitor()
    await monitor.scan()
    expect(monitor.stop(300)).toBe('stopped')
    expect(killed).toEqual([300])
    expect(monitor.stop(400)).toBe('forbidden')
    expect(monitor.stop(12345)).toBe('unknown')
    expect(killed).toEqual([300])
  })

  test('servers() exposes the last scan for the stop route and hub snapshots', async () => {
    const { monitor } = makeMonitor()
    expect(monitor.servers()).toEqual([])
    await monitor.scan()
    expect(monitor.servers().map((s) => s.port)).toEqual([5173, 3010])
  })
})
