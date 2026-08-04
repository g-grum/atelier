import { randomUUID } from 'node:crypto'
import type { QcmOption, QcmQuestion, QuestionRequest } from '@atelier/shared'
import type { CanUseTool } from '../sdk/sdk-client'

type PermissionResult = Awaited<ReturnType<CanUseTool>>

type Pending = {
  request: QuestionRequest
  /** Input original du SDK — ré-échoé tel quel dans updatedInput, answers ajouté. */
  input: Record<string, unknown>
  settle: (result: PermissionResult) => void
}

/**
 * Frère du PermissionBroker pour l'outil AskUserQuestion : une question se
 * RÉPOND (answers dans updatedInput), elle ne se décide pas — pas de règles
 * « always », pas de deny bouton. Même cycle de vie : pending ré-émis à la
 * reconnexion, abort = deny all, resolve one-shot fail-closed.
 */
export class QuestionBroker {
  private readonly requests = new Map<string, Pending>()

  constructor(private readonly sink: (event: QuestionRequest) => void) {}

  /** Entrée malformée → deny immédiat SANS publication : fail closed, le tour continue. */
  request(input: unknown): Promise<PermissionResult> {
    const questions = parseQuestions(input)
    if (questions === null) return Promise.resolve({ behavior: 'deny', message: 'Entrée AskUserQuestion invalide' })

    const request: QuestionRequest = { type: 'question_request', requestId: randomUUID(), questions }
    const promise = new Promise<PermissionResult>((settle) => {
      this.requests.set(request.requestId, { request, input: input as Record<string, unknown>, settle })
    })
    this.sink(request)
    return promise
  }

  /**
   * answers absent = « répondu en texte » (dismiss → deny). Présent mais de
   * forme invalide = no-op : la requête reste pendante et répondable (même
   * politique fail-closed que PermissionBroker.resolve default).
   */
  resolve(requestId: string, answers: Record<string, string> | undefined): void {
    const pending = this.requests.get(requestId)
    if (!pending) return

    if (answers === undefined) {
      this.requests.delete(requestId)
      pending.settle({ behavior: 'deny', message: "L'utilisateur a répondu directement dans le chat" })
      return
    }
    if (!isStringRecord(answers)) return

    this.requests.delete(requestId)
    pending.settle({ behavior: 'allow', updatedInput: { ...pending.input, answers } })
  }

  /** Requêtes en attente, plus anciennes d'abord — ré-émises à la (re)connexion. */
  pending(): QuestionRequest[] {
    return [...this.requests.values()].map((entry) => entry.request)
  }

  /** Deny tout (abort du tour, suppression de session). */
  abort(): void {
    for (const entry of this.requests.values()) {
      entry.settle({ behavior: 'deny', message: 'Session aborted' })
    }
    this.requests.clear()
  }
}

/** Valide et re-projette l'input SDK en QcmQuestion[] propre. null = malformé. */
function parseQuestions(input: unknown): QcmQuestion[] | null {
  if (typeof input !== 'object' || input === null) return null
  const questions = (input as Record<string, unknown>).questions
  if (!Array.isArray(questions) || questions.length === 0) return null

  const parsed: QcmQuestion[] = []
  for (const raw of questions) {
    if (typeof raw !== 'object' || raw === null) return null
    const { question, header, options, multiSelect } = raw as Record<string, unknown>
    if (typeof question !== 'string' || typeof header !== 'string') return null
    if (!Array.isArray(options) || options.length === 0) return null

    const parsedOptions: QcmOption[] = []
    for (const rawOption of options) {
      if (typeof rawOption !== 'object' || rawOption === null) return null
      const { label, description, preview } = rawOption as Record<string, unknown>
      if (typeof label !== 'string' || typeof description !== 'string') return null
      parsedOptions.push({ label, description, ...(typeof preview === 'string' ? { preview } : {}) })
    }
    parsed.push({ question, header, options: parsedOptions, multiSelect: multiSelect === true })
  }
  return parsed
}

/** Garde wire (le typage ne survit pas au réseau) : rejette aussi les tableaux — typeof [] === 'object'. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string')
}
