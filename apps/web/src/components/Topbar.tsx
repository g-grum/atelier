import { useState } from 'react'
import type { Project, SessionSummary } from '@atelier/shared'
import { basename } from '../lib/utils'
import type { StreamState } from '../state/stream-reducer'

/** UI labels for the shared model ids — the interactive selector is Task 5.4. */
const MODEL_LABELS: Record<string, string> = {
  'claude-fable-5': 'Fable 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-4-6': 'Sonnet 4.6',
}

export type TopbarProps = {
  project: Project | null
  session: SessionSummary | null
  status: StreamState['status']
  onRename: (name: string) => void
}

export function Topbar({ project, session, status, onRename }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          ◆
        </span>
        Atelier
      </div>
      {project !== null && (
        <div className="crumb">
          <span className="pj" style={{ background: `var(--color-${project.color})` }} aria-hidden="true" />
          {basename(project.path)} ›
        </div>
      )}
      {session !== null && <SessionTitle key={session.id} session={session} onRename={onRename} />}
      <div className="flex-1" />
      {status === 'streaming' && (
        <div className="streaming-chip">
          <span className="d" aria-hidden="true" /> streaming
        </div>
      )}
      {session !== null && (
        <div className="model-chip" title="Sélecteur de modèle à venir">
          <span className="md" aria-hidden="true" /> {MODEL_LABELS[session.model] ?? session.model}
        </div>
      )}
    </header>
  )
}

function SessionTitle({ session, onRename }: { session: SessionSummary; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const displayName = session.name ?? 'Nouvelle session'

  const startEditing = () => {
    setValue(session.name ?? '')
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    const trimmed = value.trim()
    if (trimmed !== '' && trimmed !== session.name) onRename(trimmed)
  }

  if (editing) {
    return (
      <div className="session-title">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setEditing(false)
          }}
          aria-label="Renommer la session"
          placeholder="Nom de la session"
          autoFocus
        />
      </div>
    )
  }

  return (
    <div
      className="session-title"
      role="button"
      tabIndex={0}
      onClick={startEditing}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          startEditing()
        }
      }}
      aria-label={`Renommer la session « ${displayName} »`}
    >
      {displayName} <span className="pen">✎</span>
    </div>
  )
}
