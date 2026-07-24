import { useState } from 'react'
import type { Project, SessionSummary, Theme } from '@atelier/shared'
import { basename } from '../lib/utils'
import type { StreamState } from '../state/stream-reducer'
import { ModelSelector } from './ModelSelector'
import { SettingsPanel } from './SettingsPanel'
import { ThemeToggle } from './ThemeToggle'

export type TopbarProps = {
  project: Project | null
  session: SessionSummary | null
  status: StreamState['status']
  onRename: (name: string) => void
  patchPreferences: (patch: { theme: Theme }) => Promise<unknown>
}

export function Topbar({ project, session, status, onRename, patchPreferences }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <img className="logo" src="/favicon.svg" alt="Logo Atelier" width={22} height={22} />
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
      <ModelSelector session={session} />
      <ThemeToggle patchPreferences={patchPreferences} />
      <SettingsPanel />
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
