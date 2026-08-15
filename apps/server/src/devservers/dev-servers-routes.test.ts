import { describe, expect, test } from 'bun:test'
import { DevServerMonitor } from './dev-server-monitor'
import { devServersRoutes } from './dev-servers-routes'

const LSOF = `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
node 300 g 23u IPv4 0x2 0t0 TCP 127.0.0.1:5173 (LISTEN)
python 400 g 9u IPv4 0x3 0t0 TCP 127.0.0.1:3010 (LISTEN)
`
const PS = `PID PPID
100 1
300 100
400 1
`

async function makeApp() {
  const killed: number[] = []
  const monitor = new DevServerMonitor({
    exec: async (cmd) => (cmd[0] === 'lsof' ? LSOF : PS),
    publish: () => {},
    kill: (pid) => killed.push(pid),
    selfPid: 100,
  })
  await monitor.scan()
  return { app: devServersRoutes(monitor), killed }
}

describe('POST /dev-servers/:pid/stop', () => {
  test('SIGTERMs a killable server and returns 204', async () => {
    const { app, killed } = await makeApp()
    const res = await app.request('/dev-servers/300/stop', { method: 'POST' })
    expect(res.status).toBe(204)
    expect(killed).toEqual([300])
  })

  test('a non-killable (external) server is a 403 and no kill happens', async () => {
    const { app, killed } = await makeApp()
    const res = await app.request('/dev-servers/400/stop', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(killed).toEqual([])
  })

  test('an unknown pid is a 404; a non-numeric pid is a 400', async () => {
    const { app } = await makeApp()
    expect((await app.request('/dev-servers/999/stop', { method: 'POST' })).status).toBe(404)
    expect((await app.request('/dev-servers/abc/stop', { method: 'POST' })).status).toBe(400)
  })
})
