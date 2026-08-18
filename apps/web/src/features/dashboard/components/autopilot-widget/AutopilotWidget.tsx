import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AutopilotItem, AutopilotItemStatus, AutopilotState } from '@atelier/shared'
import { errorMessage } from '@atelier/core/utils/error-message'

export type AutopilotWidgetApi = {
  getAutopilot: () => Promise<AutopilotState>
  startAutopilot: (projectId: string, maxItems?: number) => Promise<void>
  stopAutopilot: () => Promise<void>
  cleanupAutopilot: () => Promise<void>
}

export type AutopilotWidgetProps = {
  /** Config du widget — sans projectId le bouton Lancer est désactivé. */
  projectId: string
  maxItems?: number
  /** Dernier état poussé par le hub — prime sur le fetch (fraîcheur), null tant que rien n'est arrivé. */
  hubState: AutopilotState | null
  api: AutopilotWidgetApi
  /** Sélectionne la session d'un item dans l'app (réutilise la navigation existante). */
  onOpenSession?: (sessionId: string, projectId: string) => void
  /** Injectable for tests — production opens the system browser. */
  openUrl?: (url: string) => void
}

const STATUS_LABEL: Record<AutopilotItem['status'], string> = {
  queued: 'queued',
  running: 'running',
  pr_opened: 'PR opened (not merged)',
  reviewing: 'in review',
  fixing: 'fixing',
  merging: 'merging',
  merged: 'merged',
  failed: 'failed',
}

/** États sur lesquels l'item ne bougera plus — seuls eux autorisent le nettoyage. */
const TERMINAL = new Set<AutopilotItemStatus>(['pr_opened', 'failed', 'merged'])

/** Pastille : vert (mergée), rouge (échec), bleu (tout le reste, travail en cours ou PR ouverte). */
function dotClass(status: AutopilotItemStatus): string {
  if (status === 'merged') return 'merged'
  if (status === 'failed') return 'closed'
  return 'open'
}

/**
 * Widget Autopilot (spec 2026-08-05) : pilote le run (Lancer/Arrêter/Nettoyer)
 * et liste les items du dernier run — statut, lien PR, lien session. Toutes
 * les erreurs restent DANS le widget (pattern PR widget).
 */
export function AutopilotWidget({ projectId, maxItems, hubState, api, onOpenSession, openUrl = (url) => window.open(url, '_blank', 'noopener') }: AutopilotWidgetProps) {
  const queryClient = useQueryClient()
  const [actionError, setActionError] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['autopilot'],
    queryFn: api.getAutopilot,
    refetchOnWindowFocus: true,
    retry: false,
  })
  // Le hub pousse à chaque mutation serveur — quand il a parlé, il est plus frais que le fetch.
  const state = hubState ?? query.data ?? null

  const act = (action: () => Promise<void>) => {
    setActionError(null)
    action()
      .then(() => queryClient.invalidateQueries({ queryKey: ['autopilot'] }))
      .catch((err) => setActionError(errorMessage(err)))
  }

  if (state === null && query.status === 'pending') return <div className="pr-skeleton" aria-hidden="true" />
  if (state === null && query.status === 'error') {
    return (
      <div className="pr-error" role="alert">
        <span>{errorMessage(query.error)}</span>
        <button type="button" className="banner-btn" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    )
  }
  if (state === null) return null

  const running = state.run !== null
  const hasTerminal = state.items.some((i) => TERMINAL.has(i.status))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {running ? (
          <>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-indigo">
              {state.run?.state === 'stopping' ? 'stopping…' : 'run in progress'}
            </span>
            <button type="button" className="banner-btn" onClick={() => act(api.stopAutopilot)}>
              Stop
            </button>
          </>
        ) : (
          <button
            type="button"
            className="banner-btn"
            disabled={projectId === ''}
            title={projectId === '' ? 'Configure the target project first' : undefined}
            onClick={() => act(() => api.startAutopilot(projectId, maxItems))}
          >
            Run the backlog
          </button>
        )}
        {hasTerminal && !running && (
          <button type="button" className="banner-btn" onClick={() => act(api.cleanupAutopilot)}>
            Clean up
          </button>
        )}
      </div>

      {actionError !== null && (
        <p role="alert" className="pr-error m-0">{actionError}</p>
      )}
      {state.lastError !== undefined && !running && (
        <p role="alert" className="pr-error m-0">{state.lastError}</p>
      )}

      {state.items.length === 0 ? (
        <p className="pr-empty">No items — label issues “autopilot” then run the backlog</p>
      ) : (
        <ul className="pr-list">
          {state.items.map((item) => (
            <li key={item.issue} className="pr-item">
              <div className="pr-row">
                <span className="pr-line" aria-label={`Issue #${item.issue}: ${STATUS_LABEL[item.status]}`}>
                  <span className={`pr-dot ${dotClass(item.status)}`} title={STATUS_LABEL[item.status]} />
                  <span className="pr-title">#{item.issue} — {item.title}</span>
                  <span className="pr-age">{STATUS_LABEL[item.status]}</span>
                </span>
                {item.sessionId !== '' && onOpenSession !== undefined && (
                  <button type="button" className="pr-open" aria-label={`Open the session for issue #${item.issue}`} onClick={() => onOpenSession(item.sessionId, item.projectId)}>
                    ▸
                  </button>
                )}
                {item.prUrl !== undefined && (
                  <button type="button" className="pr-open" aria-label={`Open the PR for issue #${item.issue} on GitHub`} onClick={() => openUrl(item.prUrl as string)}>
                    ↗
                  </button>
                )}
              </div>
              {item.error !== undefined && <div className="pr-details">{item.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
