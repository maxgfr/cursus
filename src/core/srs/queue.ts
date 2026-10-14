import type { Id } from '../contracts/workspace'
import { type CardState, dayStart, newCardState, studyDay } from './fsrs'

export interface QueueCard {
  id: Id
  /** Cards sharing a sibling key (e.g. same fiche or cloze note) are buried together for the day. */
  sibling?: string
}

export interface QueueInput {
  cards: readonly QueueCard[]
  states: ReadonlyMap<Id, CardState>
  now: number
  tzOffsetMin: number
  newPerDay: number
}

export interface QueueEntry {
  cardId: Id
  kind: 'learning' | 'review' | 'new'
}

const byDueThenId = (a: CardState, b: CardState): number =>
  a.due !== b.due ? a.due - b.due : a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0

/**
 * Today's queue: due learning cards first, then reviews due before the end
 * of the study day, then new cards up to the remaining daily limit. A sibling
 * group reviewed today, or already represented in the queue, is buried.
 */
export function buildQueue(input: QueueInput): QueueEntry[] {
  const { cards, states, now, tzOffsetMin } = input
  const today = studyDay(now, tzOffsetMin)
  const endOfDay = dayStart(today + 1, tzOffsetMin)
  const isToday = (t: number | null): boolean => t !== null && studyDay(t, tzOffsetMin) === today

  const buried = new Set<string>()
  let newDoneToday = 0
  for (const c of cards) {
    const s = states.get(c.id)
    if (!s || !isToday(s.lastReview)) continue
    if (c.sibling !== undefined) buried.add(c.sibling)
    const first = s.history[0]
    if (first && isToday(first.at)) newDoneToday++
  }

  const learning: CardState[] = []
  const reviews: CardState[] = []
  const fresh: CardState[] = []
  const siblingOf = new Map<Id, string | undefined>()
  for (const c of cards) {
    siblingOf.set(c.id, c.sibling)
    const s = states.get(c.id) ?? newCardState(c.id)
    if (s.phase === 'new') fresh.push(s)
    else if (s.phase === 'learning' || s.phase === 'relearning') {
      if (s.due <= now) learning.push(s)
    } else if (s.due < endOfDay) reviews.push(s)
  }
  learning.sort(byDueThenId)
  reviews.sort(byDueThenId)

  const out: QueueEntry[] = []
  const taken = new Set<string>()
  const admit = (s: CardState, kind: QueueEntry['kind'], allowReviewedSibling: boolean): boolean => {
    const sib = siblingOf.get(s.cardId)
    if (sib !== undefined) {
      if (taken.has(sib)) return false
      if (buried.has(sib) && !(allowReviewedSibling && isToday(s.lastReview))) return false
      taken.add(sib)
    }
    out.push({ cardId: s.cardId, kind })
    return true
  }
  // A card in learning keeps its slot: its own earlier review today does not bury it.
  for (const s of learning) admit(s, 'learning', true)
  for (const s of reviews) admit(s, 'review', false)
  let budget = Math.max(0, input.newPerDay - newDoneToday)
  for (const s of fresh) {
    if (budget === 0) break
    if (admit(s, 'new', false)) budget--
  }
  return out
}
