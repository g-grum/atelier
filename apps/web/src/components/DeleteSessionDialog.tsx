import type { SessionSummary } from '@atelier/shared'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'

export type DeleteSessionDialogProps = {
  /** The real session awaiting confirmation — null keeps the dialog closed. */
  session: SessionSummary | null
  onConfirm: (session: SessionSummary) => void
  onCancel: () => void
}

/**
 * Confirmation gate for REAL session deletion (spec 2026-07-17): the JSONL is
 * removed for good — CLI included — so a click on × must never be enough.
 * Drafts skip this dialog; their instant delete is unchanged.
 */
export function DeleteSessionDialog({ session, onConfirm, onCancel }: DeleteSessionDialogProps) {
  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="bg-surface sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Supprimer la conversation ?</DialogTitle>
          <DialogDescription>« {session?.name ?? 'Nouvelle session'} » sera définitivement supprimée.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button type="button" className="dialog-btn" onClick={onCancel}>
            Annuler
          </button>
          <button
            type="button"
            className="dialog-btn danger"
            onClick={() => {
              if (session !== null) onConfirm(session)
            }}
          >
            Supprimer
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
