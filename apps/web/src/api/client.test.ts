import { afterEach, describe, expect, test } from 'bun:test'
import { ApiError, deleteSession } from './client'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(status: number): void {
  globalThis.fetch = (async () =>
    new Response(status === 204 ? null : JSON.stringify({ error: 'x' }), { status })) as unknown as typeof fetch
}

describe('client.deleteSession', () => {
  test('204 resolves', async () => {
    stubFetch(204)
    await expect(deleteSession('s1')).resolves.toBeUndefined()
  })

  test('404 resolves — the session is already gone, which IS the requested outcome', async () => {
    stubFetch(404)
    await expect(deleteSession('ghost')).resolves.toBeUndefined()
  })

  test('a 500 still rejects with ApiError', async () => {
    stubFetch(500)
    await expect(deleteSession('s1')).rejects.toBeInstanceOf(ApiError)
  })
})
