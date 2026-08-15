import { describe, expect, test } from 'bun:test'
import { isDescendant, labelFor, parseLsofListen, parsePsPairs } from './lsof-lib'

const LSOF_SAMPLE = `COMMAND   PID          USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    41234 germaingrumel   23u  IPv4 0xabc      0t0  TCP 127.0.0.1:5173 (LISTEN)
node    41234 germaingrumel   24u  IPv6 0xdef      0t0  TCP [::1]:5173 (LISTEN)
bun     50001 germaingrumel   11u  IPv4 0x123      0t0  TCP *:4517 (LISTEN)
ControlCe   612 germaingrumel    9u  IPv4 0x456      0t0  TCP *:7000 (LISTEN)
`

describe('parseLsofListen', () => {
  test('parses port, pid and command from LISTEN lines', () => {
    expect(parseLsofListen(LSOF_SAMPLE)).toEqual([
      { port: 5173, pid: 41234, command: 'node' },
      { port: 4517, pid: 50001, command: 'bun' },
      { port: 7000, pid: 612, command: 'ControlCe' },
    ])
  })

  test('deduplicates IPv4/IPv6 double listings of the same pid+port', () => {
    const entries = parseLsofListen(LSOF_SAMPLE).filter((e) => e.pid === 41234)
    expect(entries).toHaveLength(1)
  })

  test('command names containing spaces survive (pid = first numeric token)', () => {
    const out = 'Google Chrome 777 g 5u IPv4 0x1 0t0 TCP 127.0.0.1:9222 (LISTEN)\n'
    expect(parseLsofListen(out)).toEqual([{ port: 9222, pid: 777, command: 'Google Chrome' }])
  })

  test('empty output and non-LISTEN lines yield nothing', () => {
    expect(parseLsofListen('')).toEqual([])
    expect(parseLsofListen('node 1 g 3u IPv4 0x1 0t0 TCP 1.2.3.4:80->5.6.7.8:443 (ESTABLISHED)\n')).toEqual([])
  })
})

describe('labelFor', () => {
  test('recognizes vite from recent bash commands when the process is a runtime', () => {
    expect(labelFor('node', ['bun test', 'bunx vite --port 5173'])).toBe('vite')
  })

  test('recognizes next dev', () => {
    expect(labelFor('node', ['npx next dev'])).toBe('next')
  })

  test('recognizes bun dev / bun run dev', () => {
    expect(labelFor('bun', ['bun run dev'])).toBe('bun dev')
    expect(labelFor('bun', ['bun dev'])).toBe('bun dev')
  })

  test('most recent matching command wins', () => {
    expect(labelFor('node', ['npx next dev', 'bunx vite'])).toBe('vite')
  })

  test('falls back to the process name when nothing matches', () => {
    expect(labelFor('node', ['git status'])).toBe('node')
    expect(labelFor('node', [])).toBe('node')
  })

  test('a specific (non-runtime) process name is returned as-is', () => {
    expect(labelFor('ControlCe', ['bunx vite'])).toBe('ControlCe')
  })
})

describe('parsePsPairs / isDescendant', () => {
  const PS_SAMPLE = `  PID  PPID
    1     0
  100     1
  200   100
  300   200
  400     1
`

  test('parsePsPairs parses pid/ppid pairs, skipping the header', () => {
    expect(parsePsPairs(PS_SAMPLE)).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
      { pid: 400, ppid: 1 },
    ])
  })

  test('direct child and deep descendant are detected', () => {
    const tree = parsePsPairs(PS_SAMPLE)
    expect(isDescendant(200, [100], tree)).toBe(true)
    expect(isDescendant(300, [100], tree)).toBe(true)
  })

  test('a process is NOT its own descendant, and siblings are unrelated', () => {
    const tree = parsePsPairs(PS_SAMPLE)
    expect(isDescendant(100, [100], tree)).toBe(false)
    expect(isDescendant(400, [100], tree)).toBe(false)
  })

  test('ancestors are not descendants (desktop app never killable)', () => {
    const tree = parsePsPairs(PS_SAMPLE)
    expect(isDescendant(1, [100], tree)).toBe(false)
  })

  test('unknown pid or cyclic tree terminates safely', () => {
    const tree = parsePsPairs(PS_SAMPLE)
    expect(isDescendant(999, [100], tree)).toBe(false)
    const cyclic = [{ pid: 5, ppid: 6 }, { pid: 6, ppid: 5 }]
    expect(isDescendant(5, [100], cyclic)).toBe(false)
  })
})
