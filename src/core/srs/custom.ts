import type { Id, Rating, SessionKind, SessionScope } from '../contracts/workspace'
import { type CardState, dayStart, newCardState, retrievability, studyDay } from './fsrs'
import { inScope, type QueueCard, type QueueEntry, studyDayContext } from './queue'
import { SESSION_KINDS } from './sessionKinds'

export { SESSION_KINDS }
/** Look-ahead of an `ahead` session and look-back of a `failed` one, in study days (today included). */
export const DEFAULT_SESSION_DAYS = 7

export interface SessionQueueInput {
  cards: readonly QueueCard[]
  /** Scheduled states (practice reviews are not in them). */
  states: ReadonlyMap<Id, CardState>
  /**
   * Every non-voided review, practice included: a `failed` session looks back at them. Absent: the states'
   * histories (scheduled reviews only).
   */
  reviews?: readonly { cardId: Id; rating: Rating; at: number }[]
  now: number
  tzOffsetMin: number
  /** The student's daily new-card budget: it binds a session that counts in the schedule, never a practice one. */
  newPerDay: number
  kind: SessionKind
  scope?: SessionScope
  limit?: number
  /** Window of `ahead` and `failed`, in study days; default 7. */
  days?: number
  practice?: boolean
  /** Only these cards (relaunching a session's failed cards); a `failed` session keeps their order. */
  cardIds?: readonly Id[]
}

const cmpId = (a: Id, b: Id): number => (a < b ? -1 : a > b ? 1 : 0)
const byDue = (a: CardState, b: CardState): number => a.due - b.due || cmpId(a.cardId, b.cardId)
const entryKind = (s: CardState): QueueEntry['kind'] =>
  s.phase === 'new' ? 'new' : s.phase === 'review' ? 'review' : 'learning'

function checkInput(i: SessionQueueInput): number {
  if (!SESSION_KINDS.includes(i.kind)) throw new RangeError(`Unknown session kind ${String(i.kind)}`)
  if (i.limit !== undefined && (!Number.isInteger(i.limit) || i.limit < 0))
    throw new RangeError(`Invalid session limit ${i.limit}`)
  const days = i.days ?? DEFAULT_SESSION_DAYS
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`Invalid session window ${days}`)
  return days
}

/** Latest Again per card since `from` (study-day aligned). */
function failures(i: SessionQueueInput, from: number): Map<Id, number> {
  const out = new Map<Id, number>()
  const note = (cardId: Id, rating: Rating, at: number): void => {
    if (rating === 1 && at >= from && at <= i.now) out.set(cardId, Math.max(out.get(cardId) ?? at, at))
  }
  if (i.reviews) for (const r of i.reviews) note(r.cardId, r.rating, r.at)
  else for (const s of i.states.values()) for (const h of s.history) note(s.cardId, h.rating, h.at)
  return out
}

/**
 * A custom session's queue, fixed when it starts:
 * - `due`: learning cards due now, then reviews due today (no new card), soonest first;
 * - `ahead`: cards already seen that fall due within the next `days` study days, soonest first;
 * - `failed`: cards graded Again in the last `days` study days (practice included), oldest failure first;
 * - `new`: cards never reviewed, in the given order;
 * - `all`: every card, lowest estimated retention first, then the new ones.
 * Only cards in `scope` (and `cardIds` when given); `cards` must already exclude trashed and suspended cards. A
 * sibling group reviewed today, or already queued, is buried; new cards (whatever the kind) stay within the day's
 * remaining budget unless the session is practice. At most `limit` cards.
 */
export function buildSession(input: SessionQueueInput): QueueEntry[] {
  const days = checkInput(input)
  const { cards, states, now, tzOffsetMin, kind } = input
  const ctx = studyDayContext(cards, states, now, tzOffsetMin)
  const only = input.cardIds === undefined ? null : new Map(input.cardIds.map((id, i) => [id, i]))
  const today = studyDay(now, tzOffsetMin)
  const failedAt = kind === 'failed' && only === null ? failures(input, dayStart(today - days + 1, tzOffsetMin)) : null
  const horizon = dayStart(today + days, tzOffsetMin)

  const siblingOf = new Map<Id, string | undefined>()
  const picked: CardState[] = []
  const fresh: CardState[] = []
  for (const c of cards) {
    if (!inScope(c, input.scope) || (only !== null && !only.has(c.id))) continue
    siblingOf.set(c.id, c.sibling)
    const s = states.get(c.id) ?? newCardState(c.id)
    switch (kind) {
      case 'due':
        if (
          s.phase === 'learning' || s.phase === 'relearning'
            ? s.due <= now
            : s.phase === 'review' && s.due < ctx.endOfDay
        )
          picked.push(s)
        break
      case 'ahead':
        if (s.phase !== 'new' && s.due < horizon) picked.push(s)
        break
      case 'failed':
        if (failedAt === null || failedAt.has(c.id)) picked.push(s)
        break
      case 'new':
        if (s.phase === 'new') fresh.push(s)
        break
      case 'all':
        if (s.phase === 'new') fresh.push(s)
        else picked.push(s)
        break
    }
  }
  if (kind === 'due') {
    const learning = (s: CardState): number => (s.phase === 'review' ? 1 : 0)
    picked.sort((a, b) => learning(a) - learning(b) || byDue(a, b))
  } else if (kind === 'ahead') picked.sort(byDue)
  else if (kind === 'failed') {
    const rank = (s: CardState): number => (only ? (only.get(s.cardId) ?? 0) : (failedAt?.get(s.cardId) ?? 0))
    picked.sort((a, b) => rank(a) - rank(b) || cmpId(a.cardId, b.cardId))
  } else if (kind === 'all') {
    const r = new Map(picked.map((s) => [s.cardId, retrievability(s, now)]))
    picked.sort((a, b) => (r.get(a.cardId) ?? 0) - (r.get(b.cardId) ?? 0) || byDue(a, b))
  }

  const limit = input.limit ?? Number.POSITIVE_INFINITY
  let budget = input.practice === true ? Number.POSITIVE_INFINITY : Math.max(0, input.newPerDay - ctx.newDoneToday)
  const out: QueueEntry[] = []
  const taken = new Set<string>()
  for (const s of [...picked, ...fresh]) {
    if (out.length >= limit) break
    if (s.phase === 'new' && budget <= 0) continue
    const sib = siblingOf.get(s.cardId)
    if (sib !== undefined) {
      if (taken.has(sib)) continue
      // A card in (re)learning keeps its slot: its own earlier review today does not bury it.
      const own = (s.phase === 'learning' || s.phase === 'relearning') && ctx.isToday(s.lastReview)
      if (ctx.buried.has(sib) && !own) continue
      taken.add(sib)
    }
    if (s.phase === 'new') budget--
    out.push({ cardId: s.cardId, kind: entryKind(s) })
  }
  return out
}
