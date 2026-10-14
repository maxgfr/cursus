import type { Id, StudyScope } from '../contracts/workspace'
import { type CardState, dayStart, newCardState, studyDay } from './fsrs'

export interface QueueCard {
  id: Id
  /** Cards sharing a sibling key (e.g. same fiche or cloze note) are buried together for the day. */
  sibling?: string
  /** Needed only for a scoped queue. */
  courseId?: Id
  /** Section ids from the course root down to the card's section (empty or absent at the course root). */
  sections?: readonly Id[]
}

export interface QueueInput {
  cards: readonly QueueCard[]
  states: ReadonlyMap<Id, CardState>
  now: number
  tzOffsetMin: number
  newPerDay: number
  /**
   * Only cards of this course or subset (descendants included) are queued. Today's reviews of every card
   * still count: the daily new-card budget and sibling burying are the student's, not the subset's.
   */
  scope?: StudyScope
}

/** In the scope's course and, for a subset, filed in it or below it. No scope: every card. */
export function inScope(card: QueueCard, scope: StudyScope | undefined): boolean {
  if (scope === undefined) return true
  if (card.courseId !== scope.courseId) return false
  return scope.sectionId === undefined || (card.sections ?? []).includes(scope.sectionId)
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
 * group reviewed today, or already represented in the queue, is buried. With a scope, only that course
 * or subset is queued.
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
    if (!inScope(c, input.scope)) continue
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
