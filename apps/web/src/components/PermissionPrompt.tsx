import type { ProposedRule } from '@atelier/shared'
import type { ChatItem } from '../state/stream-reducer'

export type PermissionChatItem = Extract<ChatItem, { kind: 'permission' }>

export type PermissionDecision = 'allow' | 'deny' | 'always'

export type PermissionPromptProps = {
  item: PermissionChatItem
  onDecision: (decision: PermissionDecision) => void
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
 */
export function PermissionPrompt({ item, onDecision }: PermissionPromptProps) {
  // Resolved locally (optimistic) or via history — the decision is one-shot.
  const disabled = item.resolved !== undefined
  return (
    <div className="permission" role="alertdialog" aria-label="Demande de permission">
      <div className="p-head">
        <span className="k">Permission</span> Claude veut exécuter :
      </div>
      <code className="cmd">{item.rendered}</code>
      <div className="p-actions">
        <button type="button" className="deny" disabled={disabled} onClick={() => onDecision('deny')}>
          Refuser
        </button>
        <button type="button" disabled={disabled} onClick={() => onDecision('allow')}>
          Autoriser une fois
        </button>
        {item.proposedRule !== null && (
          <button type="button" className="allow" disabled={disabled} onClick={() => onDecision('always')}>
            Toujours pour ce projet : {ruleLabel(item.proposedRule)}
          </button>
        )}
      </div>
    </div>
  )
}
