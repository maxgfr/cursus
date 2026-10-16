import type { Id, SessionScope } from '../contracts/workspace'
import { type CardState, dayStart, newCardState, studyDay } from './fsrs'
import type { NewMix, NewOrder } from './settings'

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
  scope?: SessionScope
  /**
   * Reviews per study day at most, every course included, new cards counted too (as Anki's v3 scheduler counts
   * them): once it is reached, the remaining reviews and the new cards wait for another day. Cards in (re)learning
   * are never held back. No limit when absent.
   */
  maxReviews?: number
  /** The order new cards come in: as given (the order they were added, by default) or shuffled once. */
  newOrder?: NewOrder
  /** Where the new cards go among the reviews: after them (by default), spread among them, or before them. */
  newMix?: NewMix
}

/**
 * In the scope's course and, for a subset, filed in it or below it. No scope (or an empty one): every card. A
 * subset alone (no course) needs no course check: section ids are unique.
 */
export function inScope(card: QueueCard, scope: SessionScope | undefined): boolean {
  if (scope === undefined) return true
  if (scope.courseId !== undefined && card.courseId !== scope.courseId) return false
  return scope.sectionId === undefined || (card.sections ?? []).includes(scope.sectionId)
}

/** What today's reviews (practice ones are not in the states) mean for any queue built today. */
export interface StudyDayContext {
  /** Start of the next study day. */
  endOfDay: number
  isToday(t: number | null): boolean
  /** Sibling groups with a card reviewed today. */
  buried: ReadonlySet<string>
  /** New cards introduced today, every course included. */
  newDoneToday: number
  /** Answers given today to cards that were reviews (not new, not in learning), every course included. */
  reviewsDoneToday: number
}

export function studyDayContext(
  cards: readonly QueueCard[],
  states: ReadonlyMap<Id, CardState>,
  now: number,
  tzOffsetMin: number,
): StudyDayContext {
  const today = studyDay(now, tzOffsetMin)
  const isToday = (t: number | null): boolean => t !== null && studyDay(t, tzOffsetMin) === today
  const buried = new Set<string>()
  let newDoneToday = 0
  let reviewsDoneToday = 0
  for (const c of cards) {
    const s = states.get(c.id)
    if (!s || !isToday(s.lastReview)) continue
    if (c.sibling !== undefined) buried.add(c.sibling)
    const first = s.history[0]
    if (first && isToday(first.at)) newDoneToday++
    for (let i = s.history.length - 1; i >= 0; i--) {
      const h = s.history[i]
      if (!h || !isToday(h.at)) break
      if (h.phaseBefore === 'review') reviewsDoneToday++
    }
  }
  return { endOfDay: dayStart(today + 1, tzOffsetMin), isToday, buried, newDoneToday, reviewsDoneToday }
}

/** A rank that shuffles cards once and for all: the same on every device, every day (FNV-1a of the id). */
export function stableRank(id: Id): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** New cards in the order asked for: as given, or shuffled by `stableRank` (ties by id). */
export function orderNew<T extends { cardId: Id }>(fresh: readonly T[], order: NewOrder | undefined): T[] {
  if (order !== 'random') return [...fresh]
  return [...fresh].sort(
    (a, b) => stableRank(a.cardId) - stableRank(b.cardId) || (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0),
  )
}

/** Reviews and new cards together: new ones after, before, or spread evenly among the reviews. */
export function mixNew<T>(reviews: readonly T[], fresh: readonly T[], mix: NewMix | undefined): T[] {
  if (mix === 'before') return [...fresh, ...reviews]
  if (mix !== 'mixed' || fresh.length === 0 || reviews.length === 0) return [...reviews, ...fresh]
  const out: T[] = []
  let next = 0
  for (let i = 0; i <= reviews.length; i++) {
    // The j-th new card comes after round((j + 1) · R / (N + 1)) reviews.
    while (next < fresh.length && Math.round(((next + 1) * reviews.length) / (fresh.length + 1)) <= i) {
      out.push(fresh[next] as T)
      next++
    }
    const r = reviews[i]
    if (i < reviews.length) out.push(r as T)
  }
  return out
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
 * or subset is queued. The review limit, the order of new cards and where they go among the reviews come from
 * the settings (`maxReviews`, `newOrder`, `newMix`); without them, the defaults above.
 */
export function buildQueue(input: QueueInput): QueueEntry[] {
  const { cards, states, now, tzOffsetMin } = input
  const { endOfDay, isToday, buried, newDoneToday, reviewsDoneToday } = studyDayContext(cards, states, now, tzOffsetMin)

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

  const taken = new Set<string>()
  const admit = (s: CardState, kind: QueueEntry['kind'], allowReviewedSibling: boolean, to: QueueEntry[]): boolean => {
    const sib = siblingOf.get(s.cardId)
    if (sib !== undefined) {
      if (taken.has(sib)) return false
      if (buried.has(sib) && !(allowReviewedSibling && isToday(s.lastReview))) return false
      taken.add(sib)
    }
    to.push({ cardId: s.cardId, kind })
    return true
  }
  const out: QueueEntry[] = []
  const due: QueueEntry[] = []
  const added: QueueEntry[] = []
  // A card in learning keeps its slot: its own earlier review today does not bury it.
  for (const s of learning) admit(s, 'learning', true, out)
  let left =
    input.maxReviews === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, input.maxReviews - reviewsDoneToday - newDoneToday)
  for (const s of reviews) {
    if (left <= 0) break
    if (admit(s, 'review', false, due)) left--
  }
  let budget = Math.min(left, Math.max(0, input.newPerDay - newDoneToday))
  for (const s of orderNew(fresh, input.newOrder)) {
    if (budget <= 0) break
    if (admit(s, 'new', false, added)) budget--
  }
  return [...out, ...mixNew(due, added, input.newMix)]
}
