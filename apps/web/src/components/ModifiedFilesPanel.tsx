import { toast } from 'sonner'
import * as client from '../api/client'
import { basename, errorMessage } from '../lib/utils'

/** The slice of the REST client the panel needs — injectable for tests. */
export type ModifiedFilesApi = {
  openInIde: typeof client.openInIde
}

const defaultApi: ModifiedFilesApi = { openInIde: client.openInIde }

/**
 * Toast seam — tests inject a spy here instead of asserting on sonner
 * internals. The action is the spec's fallback when the IDE launcher fails:
 * copy the path so the user can open the file by hand.
 */
export type ToastFailure = (message: string, options: { action: { label: string; onClick: () => void } }) => void

const defaultToastFailure: ToastFailure = (message, options) => void toast.error(message, options)

export type ModifiedFilesPanelProps = {
  /** StreamState.modifiedFiles — insertion order = first touch this session. */
  files: Map<string, { added: number; removed: number; lastLine?: number }>
  api?: ModifiedFilesApi
  toastFailure?: ToastFailure
}

/**
 * « Fichiers modifiés — session » section of the right panel (mockup's
 * .file-row / .file-cap recipes): one row per Edit/Write-touched file, click
 * opens it in the IDE at its last touched line; the cap's « tout ouvrir »
 * opens the whole list.
 */
export function ModifiedFilesPanel({ files, api = defaultApi, toastFailure = defaultToastFailure }: ModifiedFilesPanelProps) {
  const notifyFailure = (file: string, reason: string): void => {
    toastFailure(`Impossible d’ouvrir ${basename(file)} dans l’IDE : ${reason}`, {
      action: {
        label: 'Copier le chemin',
        // Clipboard denial has no further fallback — the reason stays visible in the toast.
        onClick: () => void navigator.clipboard.writeText(file).catch(() => {}),
      },
    })
  }

  // The server answers { ok: false, reason } instead of a 5xx when the IDE
  // cannot be opened — both that and a transport rejection must reach the
  // user, or the click silently does nothing.
  const open = (file: string, line?: number): Promise<void> =>
    api.openInIde({ file, line }).then(
      (result) => {
        if (!result.ok) notifyFailure(file, result.reason)
      },
      (error: unknown) => notifyFailure(file, errorMessage(error)),
    )

  const openAll = async (): Promise<void> => {
    // Sequential on purpose: the server shells out to the IDE launcher, and
    // parallel spawns could race window creation. `open` never rejects.
    for (const [file, stat] of files) await open(file, stat.lastLine)
  }

  return (
    <section aria-label="Fichiers modifiés">
      <h3>Fichiers modifiés — session</h3>
      {files.size === 0 ? (
        <p className="file-empty">Aucun fichier modifié pendant cette session.</p>
      ) : (
        <>
          {[...files].map(([file, stat]) => (
            <button
              key={file}
              type="button"
              className="file-row"
              title={file}
              aria-label={`Ouvrir ${file} dans l’IDE`}
              onClick={() => void open(file, stat.lastLine)}
            >
              <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <path d="M14 3v5h5" />
              </svg>
              <span className="f">{basename(file)}</span>
              <span className="diff">
                {stat.added > 0 && <b className="add">+{stat.added}</b>}
                {stat.added > 0 && stat.removed > 0 && ' '}
                {stat.removed > 0 && <b className="del">−{stat.removed}</b>}
              </span>
              <span className="open-ide" aria-hidden="true">
                <svg className="i" viewBox="0 0 24 24">
                  <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
                </svg>
              </span>
            </button>
          ))}
          <div className="file-cap">
            <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
            </svg>
            <span>clic = IDE au fichier:ligne ·</span>
            <button type="button" className="open-all" onClick={() => void openAll()}>
              tout ouvrir
            </button>
          </div>
        </>
      )}
    </section>
  )
}
