import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppData } from '../store/app-data'
import { uploadsRoutes } from './uploads-routes'

/** AppData réel sur tmpdir jetable + un projet dont le path est un tmpdir réel. */
function freshRoutes(withProject = true) {
  const data = new AppData(join(mkdtempSync(join(tmpdir(), 'atelier-up-')), 'data.json'))
  const projectPath = mkdtempSync(join(tmpdir(), 'atelier-proj-'))
  if (withProject) data.update((d) => { d.projects.push({ id: 'p1', path: projectPath, color: '#fff' }) })
  return { app: uploadsRoutes(data), projectPath }
}

/** Requête multipart avec un fichier nommé `file`. */
function upload(app: ReturnType<typeof uploadsRoutes>, id: string, bytes: Uint8Array, type: string, name = 'x.png') {
  const form = new FormData()
  form.append('file', new File([bytes], name, { type }))
  return app.request(`/projects/${id}/uploads`, { method: 'POST', body: form })
}

describe('POST /projects/:id/uploads', () => {
  test('PNG valide → 200 { path }, fichier écrit, .atelier/.gitignore créé', async () => {
    const { app, projectPath } = freshRoutes()
    const res = await upload(app, 'p1', new Uint8Array([1, 2, 3]), 'image/png')
    expect(res.status).toBe(200)
    const { path } = (await res.json()) as { path: string }
    expect(path).toMatch(/^\.atelier\/uploads\/[0-9a-f-]+\.png$/)
    expect(existsSync(join(projectPath, path))).toBe(true)
    expect(readFileSync(join(projectPath, '.atelier/.gitignore'), 'utf8')).toBe('*\n')
  })

  test('projet inconnu → 404', async () => {
    const { app } = freshRoutes(false)
    expect((await upload(app, 'nope', new Uint8Array([1]), 'image/png')).status).toBe(404)
  })

  test('MIME non supporté → 400', async () => {
    const { app } = freshRoutes()
    expect((await upload(app, 'p1', new Uint8Array([1]), 'application/pdf', 'x.pdf')).status).toBe(400)
  })

  test('taille > 10 Mo → 400', async () => {
    const { app } = freshRoutes()
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    expect((await upload(app, 'p1', big, 'image/png')).status).toBe(400)
  })

  test('champ file absent → 400', async () => {
    const { app } = freshRoutes()
    const res = await app.request('/projects/p1/uploads', { method: 'POST', body: new FormData() })
    expect(res.status).toBe(400)
  })
})
