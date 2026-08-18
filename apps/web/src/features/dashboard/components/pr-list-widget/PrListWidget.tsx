import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PrSummary } from '@atelier/shared'
import { errorMessage } from '@atelier/core/utils/error-message'

export type PrListWidgetApi = { getGithubPrs: (repo: string, limit: number) => Promise<PrSummary[]> }

export type PrListWidgetProps = {
  repo: string
  limit: number
  api: PrListWidgetApi
  /** Ouvre le dialog de config — l'état « à configurer » (repo vide) l'affiche en bouton. */
  onConfigure?: () => void
  /** Injectable for tests — production opens the system browser via the Electron window-open handler. */
  openUrl?: (url: string) => void
}

const STATE_LABEL: Record<PrSummary['state'], string> = { open: 'open', merged: 'merged', closed: 'closed', draft: 'draft' }
const CI_LABEL = { passed: 'CI passing', failed: 'CI failing', pending: 'CI running' } as const
const REVIEW_LABEL = { approved: 'review approved', changes_requested: 'changes requested', required: 'review required' } as const

export function formatAge(updatedAt: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(updatedAt)) / 60_000))
  if (minutes < 60) return `${minutes} min`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / (24 * 60))} d`
}

/**
 * Compact-extensible list (spec): one line per PR, click expands inline
 * details, ↗ opens GitHub. All failure states stay INSIDE the widget.
 */
export function PrListWidget({ repo, limit, api, onConfigure, openUrl = (url) => window.open(url, '_blank', 'noopener') }: PrListWidgetProps) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const query = useQuery({
    queryKey: ['github-prs', repo, limit],
    queryFn: () => api.getGithubPrs(repo, limit),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
    // Repo vide = instance fraîche pas encore configurée — ne pas interroger gh.
    enabled: repo !== '',
  })

  // Instance fraîche (repo vide) : état « à configurer », pas une erreur gh.
  if (repo === '') {
    return (
      <div className="pr-setup">
        <span>Widget needs configuration — pick a GitHub repo.</span>
        {onConfigure !== undefined && (
          <button type="button" className="banner-btn" onClick={onConfigure}>
            Configure…
          </button>
        )}
      </div>
    )
  }
  if (query.status === 'pending') return <div className="pr-skeleton" aria-hidden="true" />
  if (query.status === 'error') {
    return (
      <div className="pr-error" role="alert">
        <span>{errorMessage(query.error)}</span>
        <button type="button" className="banner-btn" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    )
  }
  if (query.data.length === 0) return <p className="pr-empty">No recent PRs</p>

  return (
    <ul className="pr-list">
      {query.data.map((pr) => (
        <li key={pr.number} className="pr-item">
          <div className="pr-row">
            <button
              type="button"
              className="pr-line"
              aria-expanded={expanded === pr.number}
              onClick={() => setExpanded((current) => (current === pr.number ? null : pr.number))}
            >
              <span className={`pr-dot ${pr.state}`} title={STATE_LABEL[pr.state]} />
              <span className="pr-title">{pr.title}</span>
              <span className="pr-age">{formatAge(pr.updatedAt)}</span>
            </button>
            <button type="button" className="pr-open" aria-label={`Open PR #${pr.number} on GitHub`} onClick={() => openUrl(pr.url)}>
              ↗
            </button>
          </div>
          {expanded === pr.number && (
            <div className="pr-details">
              <span>#{pr.number}</span> · <span>{pr.author}</span> · <span>{pr.branch}</span> · <span>{STATE_LABEL[pr.state]}</span>
              {pr.ci !== null && <> · <span>{CI_LABEL[pr.ci]}</span></>}
              {pr.review !== null && <> · <span>{REVIEW_LABEL[pr.review]}</span></>}
              {' · '}<span>{new Date(pr.updatedAt).toLocaleString('en-US')}</span>
              <button type="button" className="pr-open-detail" onClick={() => openUrl(pr.url)}>
                Open on GitHub ↗
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
