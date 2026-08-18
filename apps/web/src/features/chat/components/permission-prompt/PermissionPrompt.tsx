import { useRef } from 'react'
import type { PermissionDecision, ProposedRule } from '@atelier/shared'
import type { ChatItem } from '@/state/stream-reducer'

export type PermissionChatItem = Extract<ChatItem, { kind: 'permission' }>

export type PermissionPromptProps = {
  item: PermissionChatItem
  onDecision: (decision: PermissionDecision) => void
}

/** French outcome line shown once the one-shot decision has been taken. */
const OUTCOME_LABELS: Record<PermissionDecision, string> = {
  allow: 'Allowed',
  deny: 'Denied',
  always: 'Always allowed',
}

/**
 * Human-readable scope of the proposed rule — the spec's safety display: the
 * user sees exactly what "Toujours" will allow BEFORE clicking. Bash rules
 * show the command prefix, file rules the path glob; a null matcher means the
 * whole (non-sensitive) tool, so its name stands in.
 */
function ruleLabel(rule: ProposedRule): string {
  return rule.matcher ?? rule.toolName
}

/**
 * Interactive permission card per mockup v4.2 — amber is RESERVED for
 * permissions in the design system, this is the only amber element in the app.
 * When the server proposes no safe rule (proposedRule null, unknown tools),
 * the "Toujours" button is absent — never a blanket allow.
 *
 * Semantics: the card is a labelled group, not an alertdialog — it is inline
 * and non-modal, and resolved cards linger in the transcript. The announcement
 * duty falls to an assertive live region (role="alert") wrapping the head and
 * command while the request is pending: a card inserted mid-turn is announced
 * to screen readers, and the alert role is dropped on resolution so history
 * stays silent.
 */
export function PermissionPrompt({ item, onDecision }: PermissionPromptProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const resolved = item.resolved
  const disabled = resolved !== undefined

  const decide = (decision: PermissionDecision) => {
    // The buttons are about to disable — park focus on the card first, or the
    // browser drops it to <body> and the keyboard user loses their place.
    cardRef.current?.focus()
    onDecision(decision)
  }

  return (
    <div ref={cardRef} tabIndex={-1} className="permission" role="group" aria-label="Permission request">
      <div role={disabled ? undefined : 'alert'}>
        <div className="p-head">
          <span className="k">Permission</span> Claude wants to run:
        </div>
        <code className="cmd">{item.rendered}</code>
      </div>
      <div className="p-actions">
        <button type="button" className="deny" disabled={disabled} onClick={() => decide('deny')}>
          Deny
        </button>
        <button type="button" disabled={disabled} onClick={() => decide('allow')}>
          Allow once
        </button>
        {item.proposedRule !== null && (
          <button type="button" className="allow" disabled={disabled} onClick={() => decide('always')}>
            Always for this project: {ruleLabel(item.proposedRule)}
          </button>
        )}
      </div>
      {resolved !== undefined && <div className="p-outcome">{OUTCOME_LABELS[resolved]}</div>}
    </div>
  )
}
