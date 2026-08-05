import { useState } from 'react'
import type { ProjectSummary, WidgetInstance } from '@atelier/shared'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'

export type AutopilotConfigDialogProps = {
  instance: WidgetInstance
  projects: ProjectSummary[]
  onSave: (next: WidgetInstance) => void
  onClose: () => void
}

const LABEL_CLASS = 'font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-faint'
const FIELD_CLASS =
  'w-full rounded-[7px] border border-line bg-ground px-2.5 py-[7px] font-mono text-xs text-text outline-none ' +
  'focus:border-indigo focus:shadow-[0_0_0_3px_rgba(124,134,255,0.12)]'

function clampMaxItems(raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return 3
  return Math.min(10, Math.max(1, parsed))
}

/** Configure le widget Autopilot : projet cible + nombre d'items max par run. */
export function AutopilotConfigDialog({ instance, projects, onSave, onClose }: AutopilotConfigDialogProps) {
  // Narrowing structurel : le `type` du widget ne narrowe pas l'union de config.
  const cfg = instance.config && 'projectId' in instance.config ? instance.config : undefined
  const [projectId, setProjectId] = useState(cfg?.projectId ?? projects[0]?.id ?? '')
  const [maxItemsRaw, setMaxItemsRaw] = useState(String(cfg?.maxItems ?? 3))
  const [error, setError] = useState<string | null>(null)

  const save = () => {
    if (projectId === '') {
      setError('choisis un projet cible')
      return
    }
    onSave({ ...instance, config: { projectId, maxItems: clampMaxItems(maxItemsRaw) } })
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
          <DialogTitle className="text-[15px]">Configurer le widget Autopilot</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {error !== null && (
            <p role="alert" className="m-0 rounded-lg border border-red/40 border-l-[3px] border-l-red bg-surface-2 px-3 py-2 text-xs">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <label className={LABEL_CLASS} htmlFor="autopilot-config-project">
              Projet cible
            </label>
            <select
              id="autopilot-config-project"
              className={FIELD_CLASS}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.path.split('/').at(-1) ?? project.path}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <label className={LABEL_CLASS} htmlFor="autopilot-config-max">
              Items max par run
            </label>
            <input
              id="autopilot-config-max"
              type="number"
              min={1}
              max={10}
              className={FIELD_CLASS}
              value={maxItemsRaw}
              onChange={(event) => setMaxItemsRaw(event.target.value)}
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
