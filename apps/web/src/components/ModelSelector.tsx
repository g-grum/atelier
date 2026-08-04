import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { MODELS, type SessionSummary } from '@atelier/shared'
import { type Backend, backend } from '../api/backend'
import { modelLabel } from '../lib/models'
import { errorMessage } from '../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

/** The slice of the Backend seam the selector needs — injectable for tests. */
export type ModelSelectorApi = Pick<Backend, 'patchSession'>

/** Exported for tests: proves the default wiring goes through the seam (fixtures included). */
export const defaultApi: ModelSelectorApi = { patchSession: backend.patchSession }

/** Toast seam — tests inject a spy here instead of asserting on sonner internals. */
export type ToastFailure = (message: string) => void

const defaultToastFailure: ToastFailure = (message) => void toast.error(message)

export type ModelSelectorProps = {
  /** The ACTIVE session — null (no selection) renders nothing. */
  session: SessionSummary | null
  api?: ModelSelectorApi
  toastFailure?: ToastFailure
}

/**
 * Topbar model chip (mockup's .model-chip recipe — the violet accent) opening
 * a dropdown of MODELS. Selecting one PATCHes the session's model, then
 * invalidates the sessions list so SessionSummary.model updates everywhere.
 * Per spec, the change only applies from the NEXT turn — the hint line says so.
 */
export function ModelSelector({ session, api = defaultApi, toastFailure = defaultToastFailure }: ModelSelectorProps) {
  const queryClient = useQueryClient()

  const changeModel = useMutation({
    mutationFn: ({ sessionId, model }: { sessionId: string; model: string }) => api.patchSession(sessionId, { model }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (error) => toastFailure(`Impossible de changer le modèle : ${errorMessage(error)}`),
  })

  if (session === null) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="model-chip" aria-label={`Changer de modèle — actuel : ${modelLabel(session.model)}`}>
          <span className="md" aria-hidden="true" /> {modelLabel(session.model)} <span aria-hidden="true">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem] border-line bg-surface">
        <DropdownMenuRadioGroup
          value={session.model}
          onValueChange={(model) => {
            if (model !== session.model) changeModel.mutate({ sessionId: session.id, model })
          }}
        >
          {MODELS.map((model) => (
            <DropdownMenuRadioItem key={model} value={model} className="font-mono text-xs">
              {modelLabel(model)}
            </DropdownMenuRadioItem>
          ))}
          {/* A persisted model no longer in MODELS must stay visible and checked, not silently remapped. */}
          {!MODELS.includes(session.model as (typeof MODELS)[number]) && (
            <DropdownMenuRadioItem value={session.model} className="font-mono text-xs">
              {session.model}
            </DropdownMenuRadioItem>
          )}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="m-0 px-2 py-1.5 text-[11px] text-faint">S’applique au prochain tour.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
