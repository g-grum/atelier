import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionArtifact } from '@atelier/shared'
import { SessionVisualsWidget } from './SessionVisualsWidget'

afterEach(cleanup)

const ARTIFACTS: SessionArtifact[] = [
  { path: 'shots/old.png', addedAt: '2026-08-14T09:00:00.000Z' },
  { path: 'shots/new.png', addedAt: '2026-08-14T10:00:00.000Z' },
]

describe('SessionVisualsWidget', () => {
  test('no artifacts: empty state', () => {
    render(<SessionVisualsWidget projectId="p1" artifacts={[]} />)
    expect(screen.getByText('No visuals produced yet')).toBeTruthy()
  })

  test('thumbnails newest first, src = artifacts endpoint, hover title = path', () => {
    render(<SessionVisualsWidget projectId="p1" artifacts={ARTIFACTS} />)
    const imgs = [...document.querySelectorAll('.visuals-grid img')]
    expect(imgs.map((img) => img.getAttribute('src'))).toEqual([
      '/api/projects/p1/artifacts?path=shots%2Fnew.png',
      '/api/projects/p1/artifacts?path=shots%2Fold.png',
    ])
    expect(screen.getByTitle('shots/new.png')).toBeTruthy()
    expect(screen.getByTitle('shots/old.png')).toBeTruthy()
  })

  test('click opens the lightbox (role dialog, aria-label = path) with the full-size image', () => {
    render(<SessionVisualsWidget projectId="p1" artifacts={ARTIFACTS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open shots/new.png' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('shots/new.png')
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/api/projects/p1/artifacts?path=shots%2Fnew.png')
  })

  test('Escape closes the lightbox', () => {
    render(<SessionVisualsWidget projectId="p1" artifacts={ARTIFACTS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open shots/new.png' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('clicking the overlay closes the lightbox', () => {
    render(<SessionVisualsWidget projectId="p1" artifacts={ARTIFACTS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open shots/old.png' }))
    fireEvent.click(screen.getByRole('dialog'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('img load error: neutral placeholder replaces the broken thumbnail (fixtures mode)', () => {
    render(<SessionVisualsWidget projectId="p1" artifacts={ARTIFACTS} />)
    const imgs = [...document.querySelectorAll('.visuals-grid img')]
    fireEvent.error(imgs[0]!)
    expect(document.querySelectorAll('.visuals-grid .visual-placeholder').length).toBe(1)
    expect(document.querySelectorAll('.visuals-grid img').length).toBe(1)
  })
})
