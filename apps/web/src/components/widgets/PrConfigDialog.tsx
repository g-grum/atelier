import { useState } from 'react'
import { REPO_PATTERN, type WidgetInstance } from '@atelier/shared'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'

export type PrConfigDialogProps = {
  instance: WidgetInstance
  onSave: (next: WidgetInstance) => void
  onClose: () => void
}

const LABEL_CLASS = 'font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-faint'
const FIELD_CLASS =
  'w-full rounded-[7px] border border-line bg-ground px-2.5 py-[7px] font-mono text-xs text-text outline-none ' +
  'focus:border-indigo focus:shadow-[0_0_0_3px_rgba(124,134,255,0.12)]'

function clampLimit(raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return 10
  return Math.min(30, Math.max(1, parsed))
}

/**
 * Configures a single github-prs instance (repo + limit). Rendered whenever
 * the caller has a non-null instance to configure — no internal open/close
 * state, App owns that via `configuring`.
 */
export function PrConfigDialog({ instance, onSave, onClose }: PrConfigDialogProps) {
  // Narrowing structurel : le `type` du widget ne narrowe pas l'union de config.
  const cfg = instance.config && 'repo' in instance.config ? instance.config : undefined
  const [repo, setRepo] = useState(cfg?.repo ?? '')
  // Raw string, clamped only at save time: clamping on keystroke snaps an
  // emptied field back to 10, making clear-then-retype impossible.
  const [limitRaw, setLimitRaw] = useState(String(cfg?.limit ?? 10))
  const [error, setError] = useState<string | null>(null)

  const save = () => {
    if (!REPO_PATTERN.test(repo)) {
      setError('« repo » doit être de la forme owner/repo')
      return
    }
    onSave({ ...instance, config: { repo, limit: clampLimit(limitRaw) } })
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="bg-surface sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Configurer le widget Pull Requests</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {error !== null && (
            <p role="alert" className="m-0 rounded-lg border border-red/40 border-l-[3px] border-l-red bg-surface-2 px-3 py-2 text-xs">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <label className={LABEL_CLASS} htmlFor="pr-config-repo">
              Repo (owner/nom)
            </label>
            <input
              id="pr-config-repo"
              type="text"
              className={FIELD_CLASS}
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className={LABEL_CLASS} htmlFor="pr-config-limit">
              Nombre de PRs
            </label>
            <input
              id="pr-config-limit"
              type="number"
              min={1}
              max={30}
              className={FIELD_CLASS}
              value={limitRaw}
              onChange={(event) => setLimitRaw(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <button type="button" className="dialog-btn" onClick={onClose}>
            Annuler
          </button>
          <button type="button" className="dialog-btn" onClick={save}>
            Enregistrer
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
