import { useState } from 'react'
import type { Project, ProjectGithubAccount, SessionSummary, Theme } from '@atelier/shared'
import { basename } from '@/lib/utils'
import type { StreamState } from '@/state/stream-reducer'
import { GithubAccountChip } from '@/features/settings/components/github-account-chip/GithubAccountChip'
import { ModelSelector } from '@/features/settings/components/model-selector/ModelSelector'
import { SettingsPanel } from '@/features/settings/components/settings-panel/SettingsPanel'
import { ThemeToggle } from '@/features/settings/components/theme-toggle/ThemeToggle'

export type TopbarProps = {
  project: Project | null
  session: SessionSummary | null
  status: StreamState['status']
  /** GitHub account the open project pushes as — null while loading or when the project has no GitHub remote. */
  githubAccount: ProjectGithubAccount | null
  onRename: (name: string) => void
  patchPreferences: (patch: { theme: Theme }) => Promise<unknown>
}

export function Topbar({ project, session, status, githubAccount, onRename, patchPreferences }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <img className="logo" src="/favicon.svg" alt="Atelier logo" width={22} height={22} />
        Atelier
      </div>
      {project !== null && (
        <div className="crumb">
          <span className="pj" style={{ background: `var(--color-${project.color})` }} aria-hidden="true" />
          {basename(project.path)} ›
        </div>
      )}
      {project !== null && <GithubAccountChip account={githubAccount} />}
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
  const displayName = session.name ?? 'New session'

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
          aria-label="Rename the session"
          placeholder="Session name"
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
      aria-label={`Rename the session “${displayName}”`}
    >
      {displayName} <span className="pen">✎</span>
    </div>
  )
}
