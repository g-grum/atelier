import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AutopilotItem, AutopilotState } from '@atelier/shared'
import { errorMessage } from '../../lib/utils'

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
  queued: 'en attente',
  running: 'en cours',
  pr_opened: 'PR ouverte (non mergée)',
  reviewing: 'en review',
  fixing: 'en correction',
  merging: 'merge en cours',
  merged: 'mergée',
  failed: 'échec',
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
          Réessayer
        </button>
      </div>
    )
  }
  if (state === null) return null

  const running = state.run !== null
  const hasTerminal = state.items.some((i) => i.status === 'pr_opened' || i.status === 'failed')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {running ? (
          <>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-indigo">
              {state.run?.state === 'stopping' ? 'arrêt en cours…' : 'run en cours'}
            </span>
            <button type="button" className="banner-btn" onClick={() => act(api.stopAutopilot)}>
              Arrêter
            </button>
          </>
        ) : (
          <button
            type="button"
            className="banner-btn"
            disabled={projectId === ''}
            title={projectId === '' ? 'Configure d’abord le projet cible' : undefined}
            onClick={() => act(() => api.startAutopilot(projectId, maxItems))}
          >
            Lancer le backlog
          </button>
        )}
        {hasTerminal && !running && (
          <button type="button" className="banner-btn" onClick={() => act(api.cleanupAutopilot)}>
            Nettoyer
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
        <p className="pr-empty">Aucun item — labellise des issues « autopilot » puis lance le backlog</p>
      ) : (
        <ul className="pr-list">
          {state.items.map((item) => (
            <li key={item.issue} className="pr-item">
              <div className="pr-row">
                <span className="pr-line" aria-label={`Issue #${item.issue} : ${STATUS_LABEL[item.status]}`}>
                  <span className={`pr-dot ${item.status === 'pr_opened' ? 'merged' : item.status === 'failed' ? 'closed' : 'open'}`} title={STATUS_LABEL[item.status]} />
                  <span className="pr-title">#{item.issue} — {item.title}</span>
                  <span className="pr-age">{STATUS_LABEL[item.status]}</span>
                </span>
                {item.sessionId !== '' && onOpenSession !== undefined && (
                  <button type="button" className="pr-open" aria-label={`Ouvrir la session de l’issue #${item.issue}`} onClick={() => onOpenSession(item.sessionId, item.projectId)}>
                    ▸
                  </button>
                )}
                {item.prUrl !== undefined && (
                  <button type="button" className="pr-open" aria-label={`Ouvrir la PR de l’issue #${item.issue} sur GitHub`} onClick={() => openUrl(item.prUrl as string)}>
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
