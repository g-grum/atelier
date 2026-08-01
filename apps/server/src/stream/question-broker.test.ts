import { describe, expect, test } from 'bun:test'
import type { QuestionRequest } from '@atelier/shared'
import { QuestionBroker } from './question-broker'

const VALID_INPUT = {
  questions: [
    {
      question: 'Quelle approche ?',
      header: 'Approche',
      options: [
        { label: 'A', description: 'la première' },
        { label: 'B', description: 'la seconde', preview: 'code' },
      ],
      multiSelect: false,
    },
  ],
}

function makeBroker(): { broker: QuestionBroker; published: QuestionRequest[] } {
  const published: QuestionRequest[] = []
  const broker = new QuestionBroker((request) => published.push(request))
  return { broker, published }
}

describe('QuestionBroker', () => {
  test('publie un question_request avec les questions parsées', () => {
    const { broker, published } = makeBroker()
    void broker.request(VALID_INPUT)
    expect(published).toHaveLength(1)
    expect(published[0]!.type).toBe('question_request')
    expect(published[0]!.questions).toEqual(VALID_INPUT.questions)
  })

  test('resolve avec answers → allow avec updatedInput = input original + answers', async () => {
    const { broker, published } = makeBroker()
    const promise = broker.request(VALID_INPUT)
    broker.resolve(published[0]!.requestId, { 'Quelle approche ?': 'A' })
    expect(await promise).toEqual({
      behavior: 'allow',
      updatedInput: { ...VALID_INPUT, answers: { 'Quelle approche ?': 'A' } },
    })
  })

  test('resolve sans answers → deny « répondu dans le chat »', async () => {
    const { broker, published } = makeBroker()
    const promise = broker.request(VALID_INPUT)
    broker.resolve(published[0]!.requestId, undefined)
    expect(await promise).toEqual({ behavior: 'deny', message: "L'utilisateur a répondu directement dans le chat" })
  })

  test('answers de forme invalide → no-op, la question reste répondable', async () => {
    const { broker, published } = makeBroker()
    const promise = broker.request(VALID_INPUT)
    broker.resolve(published[0]!.requestId, { q: 42 } as never)
    expect(broker.pending()).toHaveLength(1)
    broker.resolve(published[0]!.requestId, { 'Quelle approche ?': 'A' })
    expect((await promise).behavior).toBe('allow')
  })

  test('input malformé → deny immédiat, rien de publié', async () => {
    const { broker, published } = makeBroker()
    expect(await broker.request({ nope: true })).toEqual({ behavior: 'deny', message: 'Entrée AskUserQuestion invalide' })
    expect(await broker.request({ questions: [] })).toMatchObject({ behavior: 'deny' })
    expect(await broker.request({ questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }] })).toMatchObject({ behavior: 'deny' })
    expect(published).toHaveLength(0)
    expect(broker.pending()).toHaveLength(0)
  })

  test('requestId inconnu → no-op', () => {
    const { broker } = makeBroker()
    broker.resolve('inconnu', { q: 'r' }) // ne throw pas
  })

  test("pending() liste les requêtes en attente, plus anciennes d'abord", () => {
    const { broker, published } = makeBroker()
    void broker.request(VALID_INPUT)
    void broker.request(VALID_INPUT)
    expect(broker.pending()).toEqual(published)
  })

  test('abort() deny tout et vide', async () => {
    const { broker } = makeBroker()
    const promise = broker.request(VALID_INPUT)
    broker.abort()
    expect(await promise).toEqual({ behavior: 'deny', message: 'Session aborted' })
    expect(broker.pending()).toHaveLength(0)
  })
})
