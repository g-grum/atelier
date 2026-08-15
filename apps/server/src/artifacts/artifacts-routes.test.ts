import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from '../store/app-data'
import { artifactsRoutes } from './artifacts-routes'

function makeApp() {
  const parent = mkdtempSync(join(tmpdir(), 'atelier-artifacts-'))
  const projectPath = join(parent, 'proj')
  mkdirSync(join(projectPath, 'shots'), { recursive: true })
  // 1x1 PNG header bytes are irrelevant — the route serves bytes, not pixels.
  writeFileSync(join(projectPath, 'shots', 'home.png'), 'png-bytes')
  writeFileSync(join(parent, 'secret.png'), 'outside-root')
  const data = new AppData(join(parent, 'data.json'))
  data.update((d) => {
    d.projects.push({ id: 'p1', path: projectPath, color: '#fff' })
  })
  return artifactsRoutes(data)
}

describe('GET /projects/:id/artifacts', () => {
  test('serves an existing image with its content type', async () => {
    const app = makeApp()
    const res = await app.request('/projects/p1/artifacts?path=shots%2Fhome.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('png-bytes')
  })

  test('unknown project is a 404', async () => {
    const app = makeApp()
    const res = await app.request('/projects/nope/artifacts?path=shots%2Fhome.png')
    expect(res.status).toBe(404)
  })

  test('missing path param is a 400', async () => {
    const app = makeApp()
    expect((await app.request('/projects/p1/artifacts')).status).toBe(400)
  })

  test('traversal out of the project root is a 400, even toward an existing file', async () => {
    const app = makeApp()
    const res = await app.request('/projects/p1/artifacts?path=..%2Fsecret.png')
    expect(res.status).toBe(400)
  })

  test('a path inside the root but absent on disk is a 404', async () => {
    const app = makeApp()
    expect((await app.request('/projects/p1/artifacts?path=shots%2Fghost.png')).status).toBe(404)
  })

  test('non-image extensions are refused (the route only serves visuals)', async () => {
    const app = makeApp()
    expect((await app.request('/projects/p1/artifacts?path=package.json')).status).toBe(400)
  })
})
