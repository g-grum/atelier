import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import currentVersion from '../../../version.json'
import type { SessionPermissionMode, SessionSummary } from '@atelier/shared'
import { backend as defaultBackend, type Backend } from './api/backend'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { ErrorBanner } from './components/ErrorBanner'
import { ModifiedFilesPanel } from './components/ModifiedFilesPanel'
import { PermissionModeGate } from './components/PermissionModeGate'
import { SessionSidebar } from './components/SessionSidebar'
import { Topbar } from './components/Topbar'
import { UsagePanel } from './components/UsagePanel'
import { Toaster } from './components/ui/sonner'
import { errorMessage } from './lib/utils'
import { SessionController } from './state/session-controller'

export type AppProps = {
  /** Injectable for tests — defaults to the module backend (real REST+WS, or fixtures). */
  backend?: Backend
}

/**
 * Layout-only component: 3-zone grid (sidebar 262px / chat / right panel
 * 306px) under a 48px topbar. All session lifecycle lives in
 * SessionController; server data flows through react-query.
 */
export default function App({ backend = defaultBackend }: AppProps = {}) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<{ sessionId: string; projectId: string } | null>(null)
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)
  /**
   * Failure of the last controller.open() (the history fetch): without it the
   * chat would render as an innocent empty session while every send is
   * silently refused (no socket). Rendered as a banner with a retry.
   */
  const [openFailure, setOpenFailure] = useState<{ sessionId: string; projectId: string; message: string } | null>(null)
  /** Transient failure notice from session mutations (rename / create / delete). */
  const [notice, setNotice] = useState<string | null>(null)
  /** Bumped per open attempt — a stale rejection must not overwrite a newer attempt's state. */
  const openAttempt = useRef(0)

  const controller = useMemo(
    () =>
      new SessionController({
        fetchMessages: backend.getMessages,
        createSocket: backend.createSocket,
        onSessionRemapped: (mapping) => {
          // Draft handover: re-key the selection and refresh the session list.
          setSelected((current) =>
            current !== null && current.sessionId === mapping.draftId ? { ...current, sessionId: mapping.sessionId } : current,
          )
          void queryClient.invalidateQueries({ queryKey: ['sessions'] })
        },
      }),
    [backend, queryClient],
  )
  useEffect(() => () => controller.close(), [controller])

  const stream = useSyncExternalStore(
    useCallback((onChange: () => void) => controller.subscribe(onChange), [controller]),
    () => controller.getState(),
  )

  // Update detection: the server reads version.json from DISK per request,
  // this bundle bakes the version it was built from — a mismatch means the
  // repo moved on and a restart would pick it up. Polling + window focus keep
  // long-lived windows informed; failures stay silent (never a banner).
  const versionQuery = useQuery({
    queryKey: ['version'],
    queryFn: backend.getVersion,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
  /** Last version already toasted — a periodic refetch must not stack duplicates. */
  const notifiedVersion = useRef<string | null>(null)
  useEffect(() => {
    const latest = versionQuery.data
    if (latest === undefined || latest.version === currentVersion.version || notifiedVersion.current === latest.version) return
    notifiedVersion.current = latest.version
    toast('Une nouvelle version est disponible', {
      duration: Number.POSITIVE_INFINITY,
      description: (
        <>
          {latest.notes.map((note) => (
            <div key={note}>• {note}</div>
          ))}
          <div>Redémarre Atelier pour l’appliquer.</div>
        </>
      ),
    })
  }, [versionQuery.data])

  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: backend.listProjects })
  const projects = projectsQuery.data ?? []
  // Validate openProjectId against the fetched list: a stale id (the open
  // project was just unregistered in the settings dialog) must not shadow the
  // fallback — « + Session » would target a dead project (POST → 404).
  const projectId = projects.some((project) => project.id === openProjectId) ? openProjectId : (projects[0]?.id ?? null)
  // A failed background refetch (e.g. the settings dialog refetching the shared
  // ['projects'] key under fixtures) flips the query status to 'error' while
  // react-query keeps the cached data: with data on hand the sidebar must keep
  // rendering the list — the retry card is reserved for the no-data case.
  const projectsStatus = projectsQuery.status === 'error' && projectsQuery.data !== undefined ? 'success' : projectsQuery.status

  const sessionsQuery = useQuery({
    queryKey: ['sessions', projectId],
    queryFn: () => backend.listSessions(projectId ?? ''),
    enabled: projectId !== null,
  })
  const sessions = sessionsQuery.data ?? []

  const openSession = useCallback(
    (sessionId: string, projectId: string) => {
      const attempt = ++openAttempt.current
      setOpenFailure(null)
      controller.open(sessionId, projectId).catch((error: unknown) => {
        // A newer open()/close() superseded this attempt — its outcome owns the UI.
        if (attempt !== openAttempt.current) return
        setOpenFailure({ sessionId, projectId, message: errorMessage(error) })
      })
    },
    [controller],
  )

  const selectSession = useCallback(
    (session: SessionSummary) => {
      if (selected?.sessionId === session.id) return
      setSelected({ sessionId: session.id, projectId: session.projectId })
      openSession(session.id, session.projectId)
    },
    [openSession, selected],
  )

  const registerProject = useMutation({
    mutationFn: backend.registerProject,
    // Failure surfaces through `registerProject.error` in the sidebar form.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const createDraft = useMutation({
    mutationFn: (targetProjectId: string) => backend.createDraft(targetProjectId),
    onSuccess: (draft) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      selectSession(draft)
    },
    onError: (error) => setNotice(`Impossible de créer la session : ${errorMessage(error)}`),
  })

  const deleteDraft = useMutation({
    mutationFn: (session: SessionSummary) => backend.deleteSession(session.id),
    onSuccess: (_result, session) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      // react-query v5 invokes the latest render's callbacks — `selected` is current.
      if (selected?.sessionId === session.id) {
        openAttempt.current++ // orphan any in-flight open of the deleted session
        controller.close()
        setSelected(null)
        setOpenFailure(null)
      }
    },
    onError: (error) => setNotice(`Impossible de supprimer le brouillon : ${errorMessage(error)}`),
  })

  const renameSession = useMutation({
    mutationFn: ({ sessionId, name }: { sessionId: string; name: string }) => backend.patchSession(sessionId, { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (error) => setNotice(`Échec du renommage : ${errorMessage(error)}`),
  })

  const setPermissionMode = useMutation({
    mutationFn: ({ sessionId, mode }: { sessionId: string; mode: SessionPermissionMode }) =>
      backend.patchSession(sessionId, { permissionMode: mode }),
    // The gate unlocks when the refetched session carries the recorded choice.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (error) => setNotice(`Impossible d’enregistrer le choix de permissions : ${errorMessage(error)}`),
  })

  const activeSession = sessions.find((session) => session.id === selected?.sessionId) ?? null
  const activeProject = projects.find((project) => project.id === (selected?.projectId ?? projectId)) ?? null
  // Per-session permissions question (spec: chaque session demande) — an
  // unanswered session locks the composer until the user picks a mode.
  const needsPermissionChoice = activeSession !== null && activeSession.permissionMode === null

  return (
    <div className="shell">
      <Topbar
        project={activeProject}
        session={activeSession}
        status={stream.status}
        onRename={(name) => {
          if (selected !== null) renameSession.mutate({ sessionId: selected.sessionId, name })
        }}
      />
      <div className="app">
        <SessionSidebar
          projects={projects}
          projectsStatus={projectsStatus}
          projectsError={projectsQuery.error !== null ? errorMessage(projectsQuery.error) : undefined}
          onRetryProjects={() => void projectsQuery.refetch()}
          sessions={sessions}
          openProjectId={projectId}
          activeSessionId={selected?.sessionId ?? null}
          streamingSessionId={stream.status === 'streaming' ? (selected?.sessionId ?? null) : null}
          onSelectProject={setOpenProjectId}
          onSelect={selectSession}
          onCreateDraft={() => {
            if (projectId !== null) createDraft.mutate(projectId)
          }}
          onDeleteDraft={(session) => deleteDraft.mutate(session)}
          onRegisterProject={(path) => registerProject.mutate(path)}
          registerError={registerProject.error !== null ? errorMessage(registerProject.error) : null}
          registerPending={registerProject.isPending}
        />
        <main className="chat">
          {/* Above the messages: the conversation stays mounted and readable below it. */}
          <ErrorBanner status={stream.status} error={stream.error} />
          {notice !== null && (
            <div className="banner" role="alert">
              <span className="banner-text">{notice}</span>
              <button type="button" className="banner-btn" onClick={() => setNotice(null)}>
                Fermer
              </button>
            </div>
          )}
          {openFailure !== null && (
            <div className="banner" role="alert">
              <span className="banner-text">Impossible de charger la session : {openFailure.message}</span>
              <button type="button" className="banner-btn" onClick={() => openSession(openFailure.sessionId, openFailure.projectId)}>
                Réessayer
              </button>
            </div>
          )}
          <ChatView
            items={stream.items}
            status={stream.status}
            // Sends permission_response on the socket and resolves the item locally.
            onPermissionDecision={(requestId, decision) => controller.respondPermission(requestId, decision)}
            onOpenInIde={(file, line) => {
              // The server answers { ok: false, reason } instead of a 5xx when
              // the IDE cannot be opened — both that and a transport rejection
              // must reach the user, or the click silently does nothing.
              backend.openInIde({ file, line }).then(
                (result) => {
                  if (!result.ok) setNotice(`Impossible d’ouvrir dans l’IDE : ${result.reason}`)
                },
                (error: unknown) => setNotice(`Impossible d’ouvrir dans l’IDE : ${errorMessage(error)}`),
              )
            }}
          />
          {needsPermissionChoice && (
            <PermissionModeGate
              pending={setPermissionMode.isPending}
              onChoose={(mode) => {
                if (selected !== null) setPermissionMode.mutate({ sessionId: selected.sessionId, mode })
              }}
            />
          )}
          <Composer
            disabled={selected === null || needsPermissionChoice}
            status={stream.status}
            onSend={(text) => controller.sendMessage(text)}
            // Explicit abort — the only ClientMessage that stops a turn.
            onAbort={() => controller.abort()}
          />
        </main>
        <aside className="dash" aria-label="Usage et activité">
          <UsagePanel tokens={stream.sessionTokens} />
          <ModifiedFilesPanel files={stream.modifiedFiles} api={{ openInIde: backend.openInIde }} />
        </aside>
      </div>
      <Toaster />
    </div>
  )
}
