import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { SessionSummary } from '@atelier/shared'
import { backend } from './api/backend'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { SessionSidebar } from './components/SessionSidebar'
import { Topbar } from './components/Topbar'
import { SessionController } from './state/session-controller'

/**
 * Layout-only component: 3-zone grid (sidebar 262px / chat / right panel
 * 306px) under a 48px topbar. All session lifecycle lives in
 * SessionController; server data flows through react-query.
 */
export default function App() {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<{ sessionId: string; projectId: string } | null>(null)
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)

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
    [queryClient],
  )
  useEffect(() => () => controller.close(), [controller])

  const stream = useSyncExternalStore(
    useCallback((onChange: () => void) => controller.subscribe(onChange), [controller]),
    () => controller.getState(),
  )

  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: backend.listProjects })
  const projects = projectsQuery.data ?? []
  const projectId = openProjectId ?? projects[0]?.id ?? null

  const sessionsQuery = useQuery({
    queryKey: ['sessions', projectId],
    queryFn: () => backend.listSessions(projectId ?? ''),
    enabled: projectId !== null,
  })
  const sessions = sessionsQuery.data ?? []

  const selectSession = useCallback(
    (session: SessionSummary) => {
      if (selected?.sessionId === session.id) return
      setSelected({ sessionId: session.id, projectId: session.projectId })
      void controller.open(session.id, session.projectId).catch(() => {})
    },
    [controller, selected],
  )

  const registerProject = useMutation({
    mutationFn: backend.registerProject,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const createDraft = useMutation({
    mutationFn: (targetProjectId: string) => backend.createDraft(targetProjectId),
    onSuccess: (draft) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      selectSession(draft)
    },
  })

  const deleteDraft = useMutation({
    mutationFn: (session: SessionSummary) => backend.deleteSession(session.id),
    onSuccess: (_result, session) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      // react-query v5 invokes the latest render's callbacks — `selected` is current.
      if (selected?.sessionId === session.id) {
        controller.close()
        setSelected(null)
      }
    },
  })

  const renameSession = useMutation({
    mutationFn: ({ sessionId, name }: { sessionId: string; name: string }) => backend.patchSession(sessionId, { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })

  const activeSession = sessions.find((session) => session.id === selected?.sessionId) ?? null
  const activeProject = projects.find((project) => project.id === (selected?.projectId ?? projectId)) ?? null

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
        />
        <main className="chat">
          <ChatView
            items={stream.items}
            status={stream.status}
            onOpenInIde={(file, line) => {
              void backend.openInIde({ file, line })
            }}
          />
          <Composer disabled={selected === null} onSend={(text) => controller.sendMessage(text)} />
        </main>
        {/* Panels (usage, model, files, activity) land in chunk 5. */}
        <aside className="dash" aria-label="Usage et activité" />
      </div>
    </div>
  )
}
