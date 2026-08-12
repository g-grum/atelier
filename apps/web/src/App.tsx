import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import currentVersion from '../../../version.json'
import { DEFAULT_WIDGETS, type AutopilotState, type RateLimitSnapshot, type SessionPermissionMode, type SessionSummary, type WidgetInstance } from '@atelier/shared'
import { backend as defaultBackend, type Backend } from './api/backend'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { DeleteSessionDialog } from './components/DeleteSessionDialog'
import { ErrorBanner } from './components/ErrorBanner'
import { ModifiedFilesPanel } from './components/ModifiedFilesPanel'
import { PermissionModeGate } from './components/PermissionModeGate'
import { RateLimitsPanel } from './components/RateLimitsPanel'
import { SessionSidebar } from './components/SessionSidebar'
import { Topbar } from './components/Topbar'
import { Toaster } from './components/ui/sonner'
import { DashboardGrid } from './components/widgets/DashboardGrid'
import { AutopilotConfigDialog } from './components/widgets/AutopilotConfigDialog'
import { AutopilotWidget } from './components/widgets/AutopilotWidget'
import { PrConfigDialog } from './components/widgets/PrConfigDialog'
import { PrListWidget } from './components/widgets/PrListWidget'
import type { FileEntry } from './lib/file-mentions'
import { clearLastSession, readLastSession, writeLastSession } from './lib/last-session'
import { applyTheme, currentTheme } from './lib/theme'
import { errorMessage } from './lib/utils'
import { SessionController } from './state/session-controller'
import { SessionStatusStore } from './state/session-status-store'

export type AppProps = {
  /** Injectable for tests — defaults to the module backend (real REST+WS, or fixtures). */
  backend?: Backend
}

// A fetch failure must still render a usable dashboard (spec: edits keep
// failing visibly) — a fresh spread per render would be a new array identity
// every time, so this is hoisted once.
const FALLBACK_WIDGETS: WidgetInstance[] = [...DEFAULT_WIDGETS]

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
  /** Real session awaiting delete confirmation — null keeps the dialog closed. */
  const [confirmDelete, setConfirmDelete] = useState<SessionSummary | null>(null)
  /** github-prs instance awaiting configuration — null keeps the dialog closed. */
  const [configuring, setConfiguring] = useState<WidgetInstance | null>(null)
  /** Bumped per open attempt — a stale rejection must not overwrite a newer attempt's state. */
  const openAttempt = useRef(0)
  /**
   * Launch restore (spec 2026-07-24): reopen the last active session so the
   * composer is typeable without a click. Read once at mount; the one-shot
   * refs make the restore lose to ANY manual navigation during load.
   */
  const [remembered] = useState(readLastSession)
  const restoreDone = useRef(false)
  const projectRestored = useRef(false)

  const controller = useMemo(
    () =>
      new SessionController({
        fetchMessages: backend.getMessages,
        createSocket: backend.createSocket,
        onSessionRemapped: (mapping) => {
          // Draft handover: re-key the selection and re-key the cached list row.
          setSelected((current) =>
            current !== null && current.sessionId === mapping.draftId ? { ...current, sessionId: mapping.sessionId } : current,
          )
          // The launch-restore entry must follow too — a restart right after a
          // draft materializes should reopen the real session, not a dead draft id.
          const stored = readLastSession()
          if (stored !== null && stored.sessionId === mapping.draftId) writeLastSession({ ...stored, sessionId: mapping.sessionId })
          // NO refetch here: at session_started the server has already dropped
          // the draft but the SDK CLI has not flushed the session JSONL yet — a
          // refetch would return a list with NEITHER row and the conversation
          // would vanish from the sidebar until an unrelated invalidation.
          // Re-key the cached row in place; the real refetch happens at turn
          // end via statusStore.onTurnSettled (JSONL flushed by then).
          queryClient.setQueriesData<SessionSummary[]>({ queryKey: ['sessions'] }, (list) =>
            list?.map((s) => (s.id === mapping.draftId ? { ...s, id: mapping.sessionId, isDraft: false, messageCount: 1 } : s)),
          )
        },
        // Live plan gauges: each rate_limit event replaces its window in the
        // query cache — the panel moves during the turn, no refetch round-trip.
        onRateLimit: (limit) => {
          queryClient.setQueryData<RateLimitSnapshot[]>(['usageLimits'], (current = []) => [
            ...current.filter((entry) => entry.window !== limit.window),
            limit,
          ])
        },
      }),
    [backend, queryClient],
  )
  useEffect(() => () => controller.close(), [controller])

  // Hub des pastilles de statut (spec 2026-08-02) : un socket receive-only
  // séparé du flux de chat, dédié au fan-out multi-session.
  const statusStore = useMemo(() => new SessionStatusStore(), [])
  // Fin de tour = JSONL flushé côté SDK : refetch la liste (session fraîchement
  // matérialisée visible, updatedAt/messageCount à jour pour le tri).
  useEffect(() => {
    statusStore.onTurnSettled = () => void queryClient.invalidateQueries({ queryKey: ['sessions'] })
    return () => {
      statusStore.onTurnSettled = undefined
    }
  }, [statusStore, queryClient])
  const [autopilot, setAutopilot] = useState<AutopilotState | null>(null)
  useEffect(() => {
    // Dispatch par type : le hub transporte les transitions de session ET l'état autopilot (spec 2026-08-05).
    const socket = backend.createStatusSocket((event) => {
      if (event.type === 'session_status') statusStore.handle(event)
      else setAutopilot(event.autopilot)
    })
    return () => socket.close()
  }, [backend, statusStore])
  const sessionStatuses = useSyncExternalStore(statusStore.subscribe, statusStore.getSnapshot)
  // Le focus vide le bleu : une session qui redevient l'active session n'a
  // plus besoin d'attirer l'attention.
  useEffect(() => {
    statusStore.setActive(selected?.sessionId ?? null)
  }, [selected, statusStore])

  // Resync du thème depuis le serveur (source de vérité) au montage. Un flip
  // visible juste après le boot, quand le cache anti-flash diverge du disque,
  // est ATTENDU (spec charte v5) — ce n'est pas un bug.
  useEffect(() => {
    const atStart = currentTheme()
    backend.getPreferences()
      .then((p) => {
        // Don't clobber a deliberate toggle made while the GET was in flight:
        // only apply the server value if the theme is still what it was at mount.
        if (currentTheme() === atStart) applyTheme(p.theme ?? 'dark')
      })
      .catch(() => {})
  }, [backend])

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
      closeButton: true,
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

  // Baseline for the plan gauges (last-known snapshot); live rate_limit events
  // overwrite entries via onRateLimit above. Silent on failure.
  const usageLimitsQuery = useQuery({
    queryKey: ['usageLimits'],
    queryFn: backend.getUsageLimits,
    refetchInterval: 60_000,
    retry: false,
  })

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

  // Which GitHub account the open project pushes as — feeds the topbar chip.
  // Silent on failure (retry: false): the chip simply stays hidden.
  const githubAccountQuery = useQuery({
    queryKey: ['githubAccount', projectId],
    queryFn: () => backend.getProjectGithubAccount(projectId ?? ''),
    enabled: projectId !== null,
    retry: false,
  })

  // Slash commands du projet de la session ouverte (même projet que celui de
  // `activeProject`) — la liste initiale de l'autocomplétion du composer.
  // `staleTime: Infinity` : la sonde SDK côté serveur coûte ~3,8 s et la liste
  // ne bouge quasiment jamais ; un rafraîchissement en cours de session arrive
  // par l'événement WS `commands`, pas par un refetch. Silencieux sur échec
  // (retry: false) — sans liste, le composer redevient une textarea ordinaire.
  const commandsProjectId = selected?.projectId ?? projectId
  const commandsQuery = useQuery({
    queryKey: ['commands', commandsProjectId],
    queryFn: () => backend.listCommands(commandsProjectId ?? ''),
    enabled: commandsProjectId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

  // Fichiers du projet pour l'autocomplétion @ (spec 2026-08-12). staleTime
  // court (le repo bouge pendant la session), silencieux sur échec — sans
  // liste, @ ne déclenche simplement rien.
  const filesQuery = useQuery({
    queryKey: ['files', commandsProjectId],
    queryFn: () => backend.listFiles(commandsProjectId ?? ''),
    enabled: commandsProjectId !== null,
    staleTime: 30_000,
    retry: false,
  })
  // Fusion { files, dirs } → FileEntry[] mémoïsée : une prop stable pour Composer.
  const fileEntries = useMemo<FileEntry[]>(() => {
    const list = filesQuery.data
    if (list === undefined) return []
    return [
      ...list.files.map((path) => ({ path, dir: false })),
      ...list.dirs.map((path) => ({ path, dir: true })),
    ]
  }, [filesQuery.data])

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
      writeLastSession({ sessionId: session.id, projectId: session.projectId })
      openSession(session.id, session.projectId)
    },
    [openSession, selected],
  )

  // Launch restore, step 1 — the project: the sessions query is keyed on the
  // open project, so the remembered session can only be found once its project
  // is the open one. Unknown remembered project → keep the projects[0] fallback.
  useEffect(() => {
    if (projectRestored.current || restoreDone.current) return
    if (projects.length === 0) return
    projectRestored.current = true
    if (remembered !== null && projects.some((project) => project.id === remembered.projectId)) setOpenProjectId(remembered.projectId)
  }, [projects, remembered])

  // Launch restore, step 2 — the session: once the open project's list is in
  // and nothing was selected manually, open the remembered session, else the
  // most recent one (the list is drafts-first, NOT recency-sorted). One-shot:
  // any manual selection or project click during load wins over the restore.
  useEffect(() => {
    if (restoreDone.current) return
    if (selected !== null) {
      restoreDone.current = true
      return
    }
    const list = sessionsQuery.data
    if (list === undefined) return
    restoreDone.current = true
    const target =
      (remembered !== null ? list.find((session) => session.id === remembered.sessionId) : undefined) ??
      list.reduce<SessionSummary | undefined>((latest, session) => (latest === undefined || session.updatedAt > latest.updatedAt ? session : latest), undefined)
    if (target !== undefined) selectSession(target)
  }, [sessionsQuery.data, selected, selectSession, remembered])

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

  const deleteSession = useMutation({
    mutationFn: (session: SessionSummary) => backend.deleteSession(session.id),
    onSuccess: (_result, session) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      // react-query v5 invokes the latest render's callbacks — `selected` is current.
      if (selected?.sessionId === session.id) {
        openAttempt.current++ // orphan any in-flight open of the deleted session
        controller.close()
        setSelected(null)
        setOpenFailure(null)
        // The stored entry points at the dead id — clearing beats restoring a
        // fallback the user never chose at the next launch.
        clearLastSession()
      }
    },
    onError: (error) => setNotice(`Impossible de supprimer la session : ${errorMessage(error)}`),
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

  // « Se souvenir » du gate — PATCH préférences indépendant du PATCH session :
  // si l'un échoue l'autre tient (spec 2026-07-31, gestion d'erreurs).
  const rememberPermissionDefault = useMutation({
    mutationFn: (mode: SessionPermissionMode) => backend.patchPreferences({ defaultPermissionMode: mode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['preferences'] }),
    onError: (error) => setNotice(`Impossible d’enregistrer le défaut de permissions : ${errorMessage(error)}`),
  })

  // Dashboard layout — fallback to the shared default so a fetch failure
  // still renders a usable dashboard (spec: edits keep failing visibly).
  const widgetsQuery = useQuery({ queryKey: ['widgets'], queryFn: backend.getWidgets, retry: false })
  const widgets = widgetsQuery.data ?? FALLBACK_WIDGETS

  const saveWidgets = useMutation({
    mutationFn: backend.putWidgets,
    // Serialize concurrent saves (two quick drags): without a scope, an older
    // mutation's onSuccess can land AFTER a newer one and stomp its optimistic
    // state with stale server data; serialization also makes onMutate's
    // `previous` snapshot always a settled state, never an unconfirmed one.
    scope: { id: 'widgets' },
    // Optimistic: drag/resize must feel instant; rollback + toast on failure.
    onMutate: async (next: WidgetInstance[]) => {
      await queryClient.cancelQueries({ queryKey: ['widgets'] })
      const previous = queryClient.getQueryData<WidgetInstance[]>(['widgets'])
      queryClient.setQueryData(['widgets'], next)
      return { previous }
    },
    onError: (error, _next, context) => {
      queryClient.setQueryData(['widgets'], context?.previous)
      setNotice(`Impossible d’enregistrer le layout : ${errorMessage(error)}`)
    },
    onSuccess: (stored) => queryClient.setQueryData(['widgets'], stored),
  })

  const activeSession = sessions.find((session) => session.id === selected?.sessionId) ?? null
  const activeProject = projects.find((project) => project.id === (selected?.projectId ?? projectId)) ?? null
  // Per-session permissions question (spec: chaque session demande) — an
  // unanswered session locks the composer until the user picks a mode.
  const needsPermissionChoice = activeSession !== null && activeSession.permissionMode === null

  // Deliberately the ONLY usage surface — the plan limits are what matters
  // (owner's call); token cards were removed in 0.1.6.
  const renderWidget = (w: WidgetInstance) => {
    switch (w.type) {
      case 'rate-limits':
        return <RateLimitsPanel limits={usageLimitsQuery.data ?? []} />
      case 'modified-files':
        return <ModifiedFilesPanel files={stream.modifiedFiles} api={{ openInIde: backend.openInIde }} />
      case 'github-prs': {
        // Narrowing structurel : le `type` du widget ne narrowe pas l'union de config.
        const cfg = w.config && 'repo' in w.config ? w.config : undefined
        return <PrListWidget repo={cfg?.repo ?? ''} limit={cfg?.limit ?? 10} api={{ getGithubPrs: backend.getGithubPrs }} onConfigure={() => setConfiguring(w)} />
      }
      case 'autopilot': {
        const cfg = w.config && 'projectId' in w.config ? w.config : undefined
        return (
          <AutopilotWidget
            projectId={cfg?.projectId ?? ''}
            maxItems={cfg?.maxItems}
            hubState={autopilot}
            api={{
              getAutopilot: backend.getAutopilot,
              startAutopilot: backend.startAutopilot,
              stopAutopilot: backend.stopAutopilot,
              cleanupAutopilot: backend.cleanupAutopilot,
            }}
            onOpenSession={(sessionId, projectId) => {
              // Même parcours que selectSession, sans exiger un SessionSummary complet.
              setSelected({ sessionId, projectId })
              writeLastSession({ sessionId, projectId })
              openSession(sessionId, projectId)
            }}
          />
        )
      }
      default:
        return null
    }
  }

  return (
    <div className="shell">
      <Topbar
        project={activeProject}
        session={activeSession}
        status={stream.status}
        githubAccount={githubAccountQuery.data ?? null}
        onRename={(name) => {
          if (selected !== null) renameSession.mutate({ sessionId: selected.sessionId, name })
        }}
        patchPreferences={backend.patchPreferences}
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
          statuses={sessionStatuses.statuses}
          waiting={sessionStatuses.waiting}
          onSelectProject={(id) => {
            // A deliberate navigation — the pending launch restore must not
            // auto-open a session behind the user's back in this project.
            restoreDone.current = true
            setOpenProjectId(id)
          }}
          onSelect={selectSession}
          onCreateDraft={() => {
            if (projectId !== null) createDraft.mutate(projectId)
          }}
          onDelete={(session) => {
            // Drafts are empty — instant delete. A real session's JSONL is gone for
            // good (CLI included), so it goes through the confirmation dialog.
            if (session.isDraft) deleteSession.mutate(session)
            else setConfirmDelete(session)
          }}
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
            // Sends question_response on the socket and freezes the QCM card locally.
            onQuestionAnswer={(requestId, answers) => controller.answerQuestion(requestId, answers)}
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
              onChoose={(mode, remember) => {
                if (selected !== null) setPermissionMode.mutate({ sessionId: selected.sessionId, mode })
                if (remember) rememberPermissionDefault.mutate(mode)
              }}
            />
          )}
          {activeSession?.permissionMode === 'bypassPermissions' && (
            <div
              className="perm-bypass-chip"
              role="status"
              title="Défini pour cette session — le défaut se gère dans les réglages"
            >
              Skip permissions
            </div>
          )}
          <Composer
            disabled={selected === null || needsPermissionChoice}
            status={stream.status}
            // Précédence, pas de fusion (spec §5) : les deux listes viennent du
            // même producteur (le SDK), celle du WS est juste plus fraîche.
            commands={stream.commands ?? commandsQuery.data ?? []}
            files={fileEntries}
            onSend={(text) => controller.sendMessage(text)}
            // Explicit abort — the only ClientMessage that stops a turn.
            onAbort={() => controller.abort()}
          />
        </main>
        <aside className="dash" aria-label="Tableau de bord">
          <DashboardGrid widgets={widgets} onSave={(next) => saveWidgets.mutate(next)} renderWidget={renderWidget} onConfigure={setConfiguring} />
        </aside>
      </div>
      <Toaster />
      <DeleteSessionDialog
        session={confirmDelete}
        onConfirm={(session) => {
          setConfirmDelete(null)
          deleteSession.mutate(session)
        }}
        onCancel={() => setConfirmDelete(null)}
      />
      {configuring !== null && configuring.type === 'github-prs' && (
        <PrConfigDialog
          instance={configuring}
          githubAccount={githubAccountQuery.data ?? null}
          onSave={(next) => saveWidgets.mutate(widgets.map((w) => (w.id === next.id ? next : w)))}
          onClose={() => setConfiguring(null)}
        />
      )}
      {configuring !== null && configuring.type === 'autopilot' && (
        <AutopilotConfigDialog
          instance={configuring}
          projects={projectsQuery.data ?? []}
          onSave={(next) => saveWidgets.mutate(widgets.map((w) => (w.id === next.id ? next : w)))}
          onClose={() => setConfiguring(null)}
        />
      )}
    </div>
  )
}
