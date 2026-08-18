import { useState } from 'react'
import type { DevServer } from '@atelier/shared'
import { errorMessage } from '@/lib/utils'

export type DevServersWidgetApi = { stopDevServer: (pid: number) => Promise<void> }

export type DevServersWidgetProps = {
  /** Rows pushed by the status hub (dev_servers_status) — no fetch in here. */
  servers: DevServer[]
  api: DevServersWidgetApi
  /** Injectable for tests — production opens the system browser. */
  openUrl?: (url: string) => void
}

/**
 * Dev servers spotted on the machine: one row per server (port, label,
 * command). Open targets localhost; Stop only shows for servers Atelier
 * started (killable) — external ones get a muted badge instead. Errors stay
 * INSIDE the widget (pattern PR/autopilot widgets).
 */
export function DevServersWidget({ servers, api, openUrl = (url) => window.open(url, '_blank', 'noopener') }: DevServersWidgetProps) {
  const [stopError, setStopError] = useState<string | null>(null)

  if (servers.length === 0) return <p className="pr-empty">No dev servers running</p>

  const stop = (pid: number) => {
    setStopError(null)
    api.stopDevServer(pid).catch((err) => setStopError(errorMessage(err)))
  }

  return (
    <div className="flex flex-col gap-1">
      {stopError !== null && (
        <p role="alert" className="pr-error m-0">{stopError}</p>
      )}
      <ul className="pr-list">
        {servers.map((server) => (
          <li key={server.pid} className="pr-item">
            <div className="pr-row">
              <span className="pr-line srv-line">
                <span className="pr-dot open" title="running" />
                <span className="srv-port">:{server.port}</span>
                <span className="pr-title">{server.label}</span>
                <span className="srv-cmd">{server.command}</span>
              </span>
              {!server.killable && <span className="srv-external">external</span>}
              <button type="button" className="banner-btn" onClick={() => openUrl(`http://localhost:${server.port}`)}>
                Open
              </button>
              {server.killable && (
                <button type="button" className="banner-btn" onClick={() => stop(server.pid)}>
                  Stop
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
