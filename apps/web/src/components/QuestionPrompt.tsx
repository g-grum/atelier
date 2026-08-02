import { useRef, useState } from 'react'
import type { QcmQuestion } from '@atelier/shared'
import type { ChatItem } from '../state/stream-reducer'

export type QuestionChatItem = Extract<ChatItem, { kind: 'question' }>

export type QuestionPromptProps = {
  item: QuestionChatItem
  onAnswer: (answers: Record<string, string>) => void
}

/** Sélections en cours, par texte de question. useOther bascule sur le champ libre. */
type Draft = { selected: string[]; other: string; useOther: boolean }

const EMPTY_DRAFT: Draft = { selected: [], other: '', useOther: false }

/**
 * Carte QCM inline non-modale (spec 2026-07-31-ask-user-question-qcm) — même
 * patron a11y que PermissionPrompt : live region role="alert" pendant pending,
 * focus parqué sur la carte avant désactivation, carte figée une fois résolue.
 * PAS d'ambre (réservé aux permissions) : accent standard.
 *
 * Mono-question single-select : cliquer une option prédéfinie envoie
 * directement (friction zéro). « Autre » et tous les autres cas passent par le
 * bouton « Envoyer les réponses », actif quand chaque question a une réponse.
 */
export function QuestionPrompt({ item, onAnswer }: QuestionPromptProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const resolved = item.resolved
  const disabled = resolved !== undefined
  const directSend = item.questions.length === 1 && !item.questions[0]!.multiSelect

  const draftOf = (q: QcmQuestion): Draft => drafts[q.question] ?? EMPTY_DRAFT
  const setDraft = (q: QcmQuestion, patch: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [q.question]: { ...(prev[q.question] ?? EMPTY_DRAFT), ...patch } }))
  }
  const answerOf = (q: QcmQuestion): string | null => {
    const draft = draftOf(q)
    if (draft.useOther) return draft.other.trim() === '' ? null : draft.other.trim()
    // Contrat SDK : multi-select joint par virgule.
    return draft.selected.length > 0 ? draft.selected.join(', ') : null
  }
  const complete = item.questions.every((q) => answerOf(q) !== null)

  const send = (answers: Record<string, string>) => {
    // Les boutons vont se désactiver — parquer le focus sur la carte d'abord.
    cardRef.current?.focus()
    onAnswer(answers)
  }
  const submit = () => {
    const answers: Record<string, string> = {}
    for (const q of item.questions) {
      const answer = answerOf(q)
      if (answer === null) return
      answers[q.question] = answer
    }
    send(answers)
  }
  const pick = (q: QcmQuestion, label: string) => {
    if (directSend) {
      send({ [q.question]: label })
      return
    }
    const draft = draftOf(q)
    const selected = q.multiSelect
      ? draft.selected.includes(label)
        ? draft.selected.filter((l) => l !== label)
        : [...draft.selected, label]
      : [label]
    setDraft(q, { selected, useOther: false })
  }

  return (
    <div ref={cardRef} tabIndex={-1} className="question" role="group" aria-label="Question de Claude">
      <div role={disabled ? undefined : 'alert'}>
        <div className="q-head">
          <span className="k">Question</span> Claude a besoin de ton avis :
        </div>
      </div>
      {item.questions.map((q) => {
        const draft = draftOf(q)
        const chosen = item.answers?.[q.question]
        return (
          <fieldset key={q.question} className="q-block" disabled={disabled}>
            <div className="q-chip">{q.header}</div>
            <div className="q-text">{q.question}</div>
            <div className="q-options">
              {q.options.map((option) => {
                const active = resolved === 'answered' ? chosen !== undefined && splitChoices(chosen).includes(option.label) : draft.selected.includes(option.label)
                return (
                  <button
                    key={option.label}
                    type="button"
                    className={active ? 'q-option active' : 'q-option'}
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => pick(q, option.label)}
                  >
                    <span className="q-label">{option.label}</span>
                    <span className="q-desc">{option.description}</span>
                    {option.preview !== undefined && active && <code className="q-preview">{option.preview}</code>}
                  </button>
                )
              })}
              <button
                type="button"
                className={draft.useOther ? 'q-option active' : 'q-option'}
                aria-pressed={draft.useOther}
                disabled={disabled}
                onClick={() => setDraft(q, { useOther: !draft.useOther, selected: [] })}
              >
                <span className="q-label">Autre…</span>
                <span className="q-desc">Réponse libre</span>
              </button>
            </div>
            {draft.useOther && !disabled && (
              <input
                type="text"
                className="q-other"
                placeholder="Ta réponse…"
                value={draft.other}
                onChange={(e) => setDraft(q, { other: e.target.value })}
              />
            )}
          </fieldset>
        )
      })}
      {!disabled && !(directSend && !draftOf(item.questions[0]!).useOther) && (
        <div className="q-actions">
          <button type="button" className="q-submit" disabled={!complete} onClick={submit}>
            Envoyer les réponses
          </button>
        </div>
      )}
      {resolved === 'answered' && <div className="q-outcome">Répondu</div>}
      {resolved === 'dismissed' && <div className="q-outcome">Répondu dans le chat</div>}
    </div>
  )
}

/** Une réponse multi-select persistée est jointe par virgule — la re-splitter pour surligner. */
function splitChoices(answer: string): string[] {
  return answer.split(',').map((part) => part.trim())
}
