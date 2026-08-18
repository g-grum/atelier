import { useRef, useState } from 'react'
import type { Dictionary } from '@atelier/core/types'
import type { QcmQuestion } from '@atelier/shared'
import type { ChatItem } from '@/state/stream-reducer'

export type QuestionChatItem = Extract<ChatItem, { kind: 'question' }>

export type QuestionPromptProps = {
  item: QuestionChatItem
  onAnswer: (answers: Dictionary) => void
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
 * bouton « Send answers », actif quand chaque question a une réponse.
 *
 * Preview (issue #5) : la preview d'une option s'affiche au survol et au focus
 * clavier — indispensable en direct-send où le clic répond immédiatement —
 * dans une zone dédiée sous les options (hauteur animée en CSS, pas de saut
 * dans la pile de boutons). Repli : la sélection courante (ou la réponse une
 * fois résolue), pour que la preview reste visible hors survol.
 */
export function QuestionPrompt({ item, onAnswer }: QuestionPromptProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [drafts, setDrafts] = useState<Dictionary<Draft>>({})
  /** Option survolée / focalisée, par texte de question (label d'option). */
  const [hovered, setHovered] = useState<Dictionary<string | undefined>>({})
  const [focused, setFocused] = useState<Dictionary<string | undefined>>({})
  /** Dernière preview affichée par question — reste montée le temps du repli animé. */
  const lastPreview = useRef<Dictionary>({})
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

  const send = (answers: Dictionary) => {
    // Les boutons vont se désactiver — parquer le focus sur la carte d'abord.
    cardRef.current?.focus()
    onAnswer(answers)
  }
  const submit = () => {
    const answers: Dictionary = {}
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
    <div ref={cardRef} tabIndex={-1} className="question" role="group" aria-label="Question from Claude">
      <div role={disabled ? undefined : 'alert'}>
        <div className="q-head">
          <span className="k">Question</span> Claude needs your input:
        </div>
      </div>
      {item.questions.map((q) => {
        const draft = draftOf(q)
        const chosen = item.answers?.[q.question]
        const previewOf = (label: string | undefined): string | undefined =>
          label === undefined ? undefined : q.options.find((o) => o.label === label)?.preview
        // Labels retenus : la réponse une fois résolue, la sélection en cours sinon.
        const kept =
          resolved === 'answered'
            ? chosen === undefined
              ? []
              : q.multiSelect
                ? chosenLabels(chosen, q.options.map((o) => o.label))
                : [chosen]
            : draft.selected
        // Priorité : survol > focus clavier > sélection (la plus récente ayant une preview).
        // Carte résolue : le survol/focus ne pilote plus rien — les boutons disabled
        // n'émettent plus mouseleave, l'état hovered resterait figé sur la carte gelée.
        const live = resolved === undefined ? (previewOf(hovered[q.question]) ?? previewOf(focused[q.question])) : undefined
        const preview = live ?? [...kept].reverse().map(previewOf).find((p) => p !== undefined)
        // Fermeture animée : on garde le DERNIER contenu monté pendant que la zone se
        // replie (une rangée grid vide mesure 0 — la transition 1fr→0fr ne se verrait pas).
        if (preview !== undefined) lastPreview.current[q.question] = preview
        const shownPreview = preview ?? lastPreview.current[q.question]
        return (
          <fieldset key={q.question} className="q-block" disabled={disabled}>
            {/* legend en PREMIER enfant du fieldset (validité HTML) : elle porte le chip
                et la question, et les associe programmatiquement au groupe d'options. */}
            <legend className="q-legend">
              <span className="q-chip">{q.header}</span>
              <span className="q-text">{q.question}</span>
            </legend>
            <div className="q-options">
              {q.options.map((option) => {
                // Résolu : match exact en single-select (la valeur n'est jamais jointe) ;
                // re-split de la jointure virgule uniquement en multiSelect.
                const active =
                  resolved === 'answered'
                    ? chosen !== undefined &&
                      (q.multiSelect
                        ? chosenLabels(chosen, q.options.map((o) => o.label)).includes(option.label)
                        : chosen === option.label)
                    : draft.selected.includes(option.label)
                return (
                  <button
                    key={option.label}
                    type="button"
                    className={active ? 'q-option active' : 'q-option'}
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => pick(q, option.label)}
                    onMouseEnter={() => setHovered((prev) => ({ ...prev, [q.question]: option.label }))}
                    onMouseLeave={() => setHovered((prev) => ({ ...prev, [q.question]: undefined }))}
                    onFocus={() => setFocused((prev) => ({ ...prev, [q.question]: option.label }))}
                    onBlur={() => setFocused((prev) => ({ ...prev, [q.question]: undefined }))}
                  >
                    <span className="q-label">{option.label}</span>
                    <span className="q-desc">{option.description}</span>
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
                <span className="q-label">Other…</span>
                <span className="q-desc">Free-form answer</span>
              </button>
            </div>
            {q.options.some((o) => o.preview !== undefined) && (
              <div className={preview !== undefined ? 'q-preview-zone open' : 'q-preview-zone'} aria-live="polite">
                <div className="q-preview-clip">
                  {shownPreview !== undefined && <code className="q-preview">{shownPreview}</code>}
                </div>
              </div>
            )}
            {draft.useOther && !disabled && (
              <input
                type="text"
                className="q-other"
                aria-label="Free-form answer"
                placeholder="Your answer…"
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
            Send answers
          </button>
        </div>
      )}
      {resolved === 'answered' && <div className="q-outcome">Answered</div>}
      {resolved === 'dismissed' && <div className="q-outcome">Answered in chat</div>}
    </div>
  )
}

/**
 * Reconstitue les labels choisis depuis la jointure ', ' du contrat SDK. Un label
 * peut lui-même contenir ', ' — le split naïf est faux ; on cherche une décomposition
 * exacte de la réponse sur les labels connus (plus long segment d'abord, mémoïsé).
 * Pas de décomposition (réponse libre « Autre ») → rien de surligné.
 */
function chosenLabels(answer: string, labels: string[]): string[] {
  const parts = answer.split(', ')
  const known = new Set(labels)
  const memo = new Map<number, string[] | null>()
  const solve = (i: number): string[] | null => {
    if (i === parts.length) return []
    if (memo.has(i)) return memo.get(i) ?? null
    let result: string[] | null = null
    for (let j = parts.length; j > i && result === null; j--) {
      const candidate = parts.slice(i, j).join(', ')
      if (known.has(candidate)) {
        const rest = solve(j)
        if (rest !== null) result = [candidate, ...rest]
      }
    }
    memo.set(i, result)
    return result
  }
  return solve(0) ?? []
}
