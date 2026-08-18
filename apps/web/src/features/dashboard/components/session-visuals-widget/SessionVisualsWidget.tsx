import { useEffect, useState } from 'react'
import type { SessionArtifact } from '@atelier/shared'

export type SessionVisualsWidgetProps = {
  /** Project the current session belongs to — the artifacts endpoint is project-scoped. */
  projectId: string
  /** Artifacts of the CURRENT session (hub push) — the widget sorts newest first. */
  artifacts: SessionArtifact[]
}

/** GET endpoint serving the artifact bytes (server side, spec 2026-08-14). */
function artifactUrl(projectId: string, path: string): string {
  return `/api/projects/${projectId}/artifacts?path=${encodeURIComponent(path)}`
}

/**
 * Thumbnail grid of the visuals the current session produced (screenshots,
 * mockups…), newest first. Click opens a full-size lightbox — Esc or click
 * closes. A thumbnail whose bytes cannot load (fixtures mode, deleted file)
 * degrades to a neutral placeholder block instead of a broken image.
 */
export function SessionVisualsWidget({ projectId, artifacts }: SessionVisualsWidgetProps) {
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())

  // Esc ferme la lightbox — listener global, seulement quand elle est ouverte.
  useEffect(() => {
    if (openPath === null) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenPath(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openPath])

  if (artifacts.length === 0) return <p className="pr-empty">No visuals produced yet</p>

  const sorted = [...artifacts].sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
  const markFailed = (path: string) => setFailed((prev) => new Set(prev).add(path))

  return (
    <>
      <div className="visuals-grid">
        {sorted.map((artifact) => (
          <button
            key={artifact.path}
            type="button"
            className="visual-thumb"
            title={artifact.path}
            aria-label={`Open ${artifact.path}`}
            onClick={() => setOpenPath(artifact.path)}
          >
            {failed.has(artifact.path) ? (
              <span className="visual-placeholder" aria-hidden="true" />
            ) : (
              <img src={artifactUrl(projectId, artifact.path)} alt={artifact.path} loading="lazy" onError={() => markFailed(artifact.path)} />
            )}
          </button>
        ))}
      </div>
      {openPath !== null && (
        <div className="visual-lightbox" role="dialog" aria-label={openPath} onClick={() => setOpenPath(null)}>
          {failed.has(openPath) ? (
            <span className="visual-placeholder large" aria-hidden="true" />
          ) : (
            <img src={artifactUrl(projectId, openPath)} alt={openPath} onError={() => markFailed(openPath)} />
          )}
        </div>
      )}
    </>
  )
}
