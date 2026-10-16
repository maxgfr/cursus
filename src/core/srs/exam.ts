import type { Id, Rating } from '../contracts/workspace'
import { type CardState, retrievability } from './fsrs'

/*
 * An exam: a batch of cards drawn from a part of a course, gone over until every one is known. Each sitting draws
 * the cards the plan has gone over least lately (never first), the weakest first among them, so consecutive sittings
 * go through the whole part. In the sitting, a card graded Again or Hard comes back a few cards later; it is known
 * once graded Good or Easy since its last miss, and the sitting ends when the whole batch is known.
 */

/** How many cards an exam draws: what a student takes on for one part of a course. */
export const EXAM_SIZE = { min: 50, max: 80, default: 60 } as const

/** Other answers before a missed card comes back, while other cards are still waiting. */
export const EXAM_GAP = 4

export interface ExamBatchInput {
  /** The part's cards, in the order new ones come in. */
  cards: readonly Id[]
  /** Scheduled states (practice reviews are not in them); a card without one was never reviewed. */
  states: ReadonlyMap<Id, CardState>
  /** When each card was last answered in an earlier sitting of the same plan. */
  sat?: ReadonlyMap<Id, number>
  now: number
  size: number
}

const cmpNum = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The cards of a sitting, at most `size` (all of them in a smaller part): those the plan has not gone over yet first,
 * then those it went over longest ago; within each, never reviewed or least likely recalled first, then the most
 * forgotten, then in the part's order.
 */
export function examBatch(i: ExamBatchInput): Id[] {
  if (!Number.isInteger(i.size) || i.size < 1) throw new RangeError(`Invalid exam size ${i.size}`)
  const order = new Map<Id, number>()
  for (const id of i.cards) if (!order.has(id)) order.set(id, order.size)
  const sat = (id: Id): number => i.sat?.get(id) ?? Number.NEGATIVE_INFINITY
  const recall = new Map<Id, number>()
  for (const id of order.keys()) {
    const s = i.states.get(id)
    recall.set(id, s === undefined ? 0 : retrievability(s, i.now))
  }
  const lapses = (id: Id): number => i.states.get(id)?.lapses ?? 0
  return [...order.keys()]
    .sort(
      (a, b) =>
        cmpNum(sat(a), sat(b)) ||
        cmpNum(recall.get(a) ?? 0, recall.get(b) ?? 0) ||
        lapses(b) - lapses(a) ||
        (order.get(a) ?? 0) - (order.get(b) ?? 0),
    )
    .slice(0, i.size)
}

export interface ExamAnswer {
  cardId: Id
  rating: Rating
}

/** Good and Easy: the card is known. Again and Hard send it back. */
export const knows = (r: Rating): boolean => r >= 3

interface Tally {
  /** The batch, each card once. */
  cards: Id[]
  last: Map<Id, { rating: Rating; at: number }>
  passes: Map<Id, number>
}

function tally(batch: readonly Id[], answers: readonly ExamAnswer[]): Tally {
  const cards = [...new Set(batch)]
  const inBatch = new Set(cards)
  const last = new Map<Id, { rating: Rating; at: number }>()
  const passes = new Map<Id, number>()
  for (const [at, a] of answers.entries()) {
    if (!inBatch.has(a.cardId)) continue
    last.set(a.cardId, { rating: a.rating, at })
    passes.set(a.cardId, (passes.get(a.cardId) ?? 0) + 1)
  }
  return { cards, last, passes }
}

const isKnown = (t: Tally, id: Id): boolean => {
  const l = t.last.get(id)
  return l !== undefined && knows(l.rating)
}

/** How many of the batch are known: graded Good or Easy since their last miss. Done once all of them are. */
export function examProgress(
  batch: readonly Id[],
  answers: readonly ExamAnswer[],
): { known: number; total: number; done: boolean } {
  const t = tally(batch, answers)
  const known = t.cards.filter((id) => isKnown(t, id)).length
  return { known, total: t.cards.length, done: known === t.cards.length }
}

/**
 * The next card of a sitting, from its answers so far (in order); null once the whole batch is known. A missed card
 * comes back once `gap` other answers were given since, before any card not seen yet; with nothing else left, the one
 * missed longest ago comes back at once.
 */
export function examNext(batch: readonly Id[], answers: readonly ExamAnswer[], gap: number = EXAM_GAP): Id | null {
  const t = tally(batch, answers)
  const n = answers.length
  let missed: { id: Id; at: number } | null = null
  let unseen: Id | null = null
  for (const id of t.cards) {
    const l = t.last.get(id)
    if (l === undefined) unseen ??= id
    else if (!knows(l.rating) && (missed === null || l.at < missed.at)) missed = { id, at: l.at }
  }
  if (missed !== null && (unseen === null || n - 1 - missed.at >= gap)) return missed.id
  return unseen
}

/** The cards that took several passes, most passes first (then in the order they were first answered). */
export function examStruggled(batch: readonly Id[], answers: readonly ExamAnswer[]): { cardId: Id; passes: number }[] {
  const t = tally(batch, answers)
  return [...t.passes.entries()]
    .filter(([, passes]) => passes > 1)
    .map(([cardId, passes]) => ({ cardId, passes }))
    .sort((a, b) => b.passes - a.passes)
}
