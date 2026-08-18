import { useRef } from 'react'
import type { SessionSummary } from '@atelier/shared'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog/dialog'

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
  // Radix keeps the content mounted through the exit animation after App nulls
  // the session — cache the last real one so the copy never flashes the fallback
  // name mid-close. (Untestable under happy-dom: no animations there.)
  const lastSession = useRef(session)
  if (session !== null) lastSession.current = session
  const shown = session ?? lastSession.current
  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="bg-surface sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Delete this conversation?</DialogTitle>
          <DialogDescription>“{shown?.name ?? 'New session'}” will be permanently deleted.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button type="button" className="dialog-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="dialog-btn danger"
            onClick={() => {
              if (session !== null) onConfirm(session)
            }}
          >
            Delete
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
