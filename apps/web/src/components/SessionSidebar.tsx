import { useState } from 'react'
import type { ProjectSummary, SessionSummary } from '@atelier/shared'
import { basename } from '../lib/utils'
import { SessionListItem, type SessionDotState } from './SessionListItem'

export type SessionSidebarProps = {
  projects: ProjectSummary[]
  /**
   * Status of the projects fetch. The first-launch register form is gated on
   * 'success': while 'pending' nothing shows (no flash on startup), and
   * 'error' shows a retry card — an empty list is only trusted once the
   * server actually said so.
   */
  projectsStatus: 'pending' | 'error' | 'success'
  /** Message of the failed projects fetch (shown when projectsStatus === 'error'). */
  projectsError?: string
  onRetryProjects: () => void
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
  /** Message of a failed POST /api/projects (shown inside the register form). */
  registerError?: string | null
  registerPending?: boolean
}

export function SessionSidebar(props: SessionSidebarProps) {
  const { projects, projectsStatus, projectsError, onRetryProjects, sessions, openProjectId, onSelectProject, onCreateDraft } = props

  // Permanent « + Projet » affordance (v0.2): a discreet footer toggle reusing
  // the same RegisterProjectForm as the first-launch empty state.
  const [registerOpen, setRegisterOpen] = useState(false)
  // Auto-close on success: a grown projects list means the POST landed and the
  // list refetched. Adjust-state-during-render (React's documented pattern for
  // reacting to prop changes) so the form never flashes an extra frame.
  const [seenProjectCount, setSeenProjectCount] = useState(projects.length)
  if (projects.length !== seenProjectCount) {
    setSeenProjectCount(projects.length)
    if (projects.length > seenProjectCount) setRegisterOpen(false)
  }

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
      {projectsStatus === 'pending' ? (
        <p className="side-note">Chargement des projets…</p>
      ) : projectsStatus === 'error' ? (
        <div className="side-error" role="alert">
          <p>Impossible de charger les projets{projectsError !== undefined ? ` : ${projectsError}` : ''}</p>
          <button type="button" className="new-btn" onClick={onRetryProjects}>
            Réessayer
          </button>
        </div>
      ) : projects.length === 0 ? (
        <RegisterProjectForm
          intro="Aucun projet enregistré. Indiquez le dossier d’un dépôt pour commencer."
          onRegister={props.onRegisterProject}
          error={props.registerError ?? null}
          pending={props.registerPending ?? false}
        />
      ) : (
        <>
          {projects.map((project) => (
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
                {/* The open project's count comes from the live sessions list
                    (refetched on every draft/turn) — fresher than the projects
                    snapshot's sessionCount, which only updates when the
                    projects query refetches. Closed rows show the
                    server-computed sessionCount. */}
                <span className="count">{project.id === openProjectId ? sessions.length : project.sessionCount}</span>
              </div>
              {project.id === openProjectId && <SessionList {...props} />}
            </div>
          ))}
          <div className="sidebar-foot">
            <button
              type="button"
              className="add-project"
              aria-expanded={registerOpen}
              onClick={() => setRegisterOpen((open) => !open)}
            >
              + Projet
            </button>
            {registerOpen && (
              <RegisterProjectForm
                onRegister={props.onRegisterProject}
                error={props.registerError ?? null}
                pending={props.registerPending ?? false}
              />
            )}
          </div>
        </>
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

function RegisterProjectForm({
  onRegister,
  error,
  pending,
  intro,
}: {
  onRegister: (path: string) => void
  error: string | null
  pending: boolean
  /** Leading sentence — the empty state explains itself, the footer toggle does not need to. */
  intro?: string
}) {
  const [path, setPath] = useState('')
  const submit = () => {
    const trimmed = path.trim()
    if (trimmed !== '' && !pending) onRegister(trimmed)
  }
  return (
    <form
      className="register"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {intro !== undefined && <p>{intro}</p>}
      <input
        value={path}
        onChange={(event) => setPath(event.target.value)}
        placeholder="/chemin/absolu/du/projet"
        aria-label="Chemin du dossier du projet"
        spellCheck={false}
      />
      <button type="submit" className="new-btn" disabled={pending}>
        {pending ? 'Enregistrement…' : 'Enregistrer'}
      </button>
      {error !== null && (
        <p className="form-error" role="alert">
          Échec de l’enregistrement : {error}
        </p>
      )}
    </form>
  )
}
