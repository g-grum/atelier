import { useState } from 'react'
import type { Project, SessionSummary } from '@atelier/shared'
import { basename } from '../lib/utils'
import { SessionListItem, type SessionDotState } from './SessionListItem'

export type SessionSidebarProps = {
  projects: Project[]
  /** Sessions of the open project (v0.1 loads one project's sessions at a time). */
  sessions: SessionSummary[]
  openProjectId: string | null
  activeSessionId: string | null
  /** The session currently streaming (the active one while status === 'streaming'). */
  streamingSessionId: string | null
  onSelectProject: (projectId: string) => void
  onSelect: (session: SessionSummary) => void
  onCreateDraft: () => void
  onDeleteDraft: (session: SessionSummary) => void
  /** First-launch bootstrap: register a folder as the project (POST /api/projects). */
  onRegisterProject: (path: string) => void
}

export function SessionSidebar(props: SessionSidebarProps) {
  const { projects, sessions, openProjectId, onSelectProject, onCreateDraft } = props

  return (
    <nav className="sidebar" aria-label="Projets et sessions">
      <div className="sidebar-head">
        <span className="label">Projets</span>
        {projects.length > 0 && (
          <button type="button" className="new-btn" onClick={onCreateDraft}>
            + Session
          </button>
        )}
      </div>
      {projects.length === 0 ? (
        <RegisterProjectForm onRegister={props.onRegisterProject} />
      ) : (
        projects.map((project) => (
          <div className="project" key={project.id}>
            <div
              className={`project-name${project.id === openProjectId ? ' open' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelectProject(project.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelectProject(project.id)
                }
              }}
            >
              <span className="pj-dot" style={{ background: `var(--color-${project.color})` }} aria-hidden="true" />
              {basename(project.path)}
              {project.id === openProjectId && <span className="count">{sessions.length}</span>}
            </div>
            {project.id === openProjectId && <SessionList {...props} />}
          </div>
        ))
      )}
    </nav>
  )
}

function SessionList({ sessions, activeSessionId, streamingSessionId, onSelect, onDeleteDraft }: SessionSidebarProps) {
  const ordered = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return (
    <>
      {ordered.map((session) => (
        <SessionListItem
          key={session.id}
          session={session}
          active={session.id === activeSessionId}
          state={dotState(session, streamingSessionId)}
          onSelect={() => onSelect(session)}
          onDelete={session.isDraft ? () => onDeleteDraft(session) : undefined}
        />
      ))}
    </>
  )
}

function dotState(session: SessionSummary, streamingSessionId: string | null): SessionDotState {
  if (session.id === streamingSessionId) return 'run'
  if (session.isDraft || session.messageCount === 0) return 'idle'
  return 'done'
}

function RegisterProjectForm({ onRegister }: { onRegister: (path: string) => void }) {
  const [path, setPath] = useState('')
  const submit = () => {
    const trimmed = path.trim()
    if (trimmed !== '') onRegister(trimmed)
  }
  return (
    <form
      className="register"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <p>Aucun projet enregistré. Indiquez le dossier d’un dépôt pour commencer.</p>
      <input
        value={path}
        onChange={(event) => setPath(event.target.value)}
        placeholder="/chemin/absolu/du/projet"
        aria-label="Chemin du dossier du projet"
        spellCheck={false}
      />
      <button type="submit" className="new-btn">
        Enregistrer
      </button>
    </form>
  )
}
