import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { watchStdin } from './stdin-watchdog'

/** Stub de stdin : EventEmitter + resume() observable. */
function makeStdin() {
  const emitter = new EventEmitter() as EventEmitter & { resume: () => void; resumed: boolean }
  emitter.resumed = false
  emitter.resume = () => {
    emitter.resumed = true
  }
  return emitter
}

describe('watchStdin', () => {
  test('déclenche onOrphaned quand stdin se ferme (end)', () => {
    const stdin = makeStdin()
    const onOrphaned = mock(() => {})
    watchStdin(stdin, onOrphaned)
    stdin.emit('end')
    expect(onOrphaned).toHaveBeenCalledTimes(1)
  })

  test('déclenche une seule fois même si end PUIS close arrivent', () => {
    const stdin = makeStdin()
    const onOrphaned = mock(() => {})
    watchStdin(stdin, onOrphaned)
    stdin.emit('end')
    stdin.emit('close')
    expect(onOrphaned).toHaveBeenCalledTimes(1)
  })

  test('met le flux en mode flowing (resume) pour recevoir end', () => {
    const stdin = makeStdin()
    watchStdin(stdin, () => {})
    expect(stdin.resumed).toBe(true)
  })
})
