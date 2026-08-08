import { describe, expect, test } from 'bun:test'
import { createWorkspace } from './workspace'

type Call = { cmd: string[]; cwd: string }

function fakeExec(results: { exitCode?: number; stderr?: string }[] = []) {
  const calls: Call[] = []
  const exec = async (cmd: string[], cwd: string) => {
    calls.push({ cmd, cwd })
    const r = results.shift() ?? {}
    return { stdout: '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 }
  }
  return { exec, calls }
}

describe('workspace', () => {
  test('prepare crée le worktree sur sa branche puis lance bun install dedans', async () => {
    const { exec, calls } = fakeExec()
    const ws = createWorkspace('/repo', exec)
    const { path, branch } = await ws.prepare(42)
    expect(path).toBe('/repo/.worktrees/autopilot-42')
    expect(branch).toBe('autopilot/42')
    expect(calls[0]).toEqual({ cmd: ['git', 'worktree', 'add', '.worktrees/autopilot-42', '-b', 'autopilot/42'], cwd: '/repo' })
    expect(calls[1]).toEqual({ cmd: [process.execPath, 'install'], cwd: '/repo/.worktrees/autopilot-42' })
  })

  test('prepare échoue en FR si git échoue', async () => {
    const { exec } = fakeExec([{ exitCode: 1, stderr: 'boom' }])
    expect(createWorkspace('/repo', exec).prepare(7)).rejects.toThrow('création du worktree impossible : boom')
  })

  test('prepare échoue en FR si bun install échoue', async () => {
    const { exec } = fakeExec([{}, { exitCode: 1, stderr: 'lockfile' }])
    expect(createWorkspace('/repo', exec).prepare(7)).rejects.toThrow('installation des dépendances impossible : lockfile')
  })

  test('cleanup enchaîne worktree remove --force puis branch -D, et tolère les échecs individuels', async () => {
    const { exec, calls } = fakeExec([{ exitCode: 1, stderr: 'sale' }, {}])
    await createWorkspace('/repo', exec).cleanup(42)
    expect(calls[0]).toEqual({ cmd: ['git', 'worktree', 'remove', '--force', '.worktrees/autopilot-42'], cwd: '/repo' })
    expect(calls[1]).toEqual({ cmd: ['git', 'branch', '-D', 'autopilot/42'], cwd: '/repo' })
  })

  test('cleanup retire aussi le fichier de verdict de review (best-effort)', async () => {
    const { exec, calls } = fakeExec([{}, {}, { exitCode: 1, stderr: 'absent' }])
    await createWorkspace('/repo', exec).cleanup(7)
    expect(calls[2]).toEqual({ cmd: ['rm', '-f', '.worktrees/review-7.json'], cwd: '/repo' })
  })
})
