import type {
  Id,
  NewReview,
  NewSession,
  PlanInput,
  Rating,
  Session,
  SessionKind,
  SessionScope,
} from '../contracts/workspace'
import { buildSession } from '../srs/custom'
import { type CardState, createScheduler, localOffset } from '../srs/fsrs'
import type { QueueEntry } from '../srs/queue'
import { EntityNotFoundError } from './repos'
import type { ReviewEvent } from './reviews'
import type { PlanRecord } from './schema'
import { cleanScope, cmp, parseTime } from './sessionLog'
import type { ModelWorkspace } from './workspace'

export { PlanRepo, parseTime, SessionInputError, SessionLog } from './sessionLog'

/** A review given in a session: tagged with it, and practice when the session stays out of the schedule. */
export function sessionReview(session: Pick<Session, 'id' | 'practice'>, r: NewReview): NewReview {
  const out: NewReview = { cardId: r.cardId, rating: r.rating, at: r.at, ms: r.ms, sid: session.id }
  if (session.practice) out.p = true
  return out
}

export function planScope(p: Pick<PlanInput, 'courseId' | 'sectionId'>): SessionScope {
  return cleanScope({ courseId: p.courseId, sectionId: p.sectionId })
}

/** The session a plan starts. */
export function planSession(p: PlanRecord): NewSession {
  const s: NewSession = { scope: planScope(p), kind: p.kind, practice: p.practice, planId: p.id }
  if (p.limit !== undefined) s.limit = p.limit
  return s
}

/**
 * The plan's next occurrence at or after `now`, in epoch ms: its local time on the next of its weekdays.
 * `offsetAt` gives the zone's offset (minutes east of UTC) at an instant, so daylight saving time is followed.
 * Null for a trashed plan or one without valid weekdays.
 */
export function nextOccurrence(
  p: Pick<PlanRecord, 'weekdays' | 'time'> & { deletedAt?: number },
  now: number,
  offsetAt: (at: number) => number = localOffset,
): number | null {
  if (p.deletedAt !== undefined) return null
  const { hour, minute } = parseTime(p.time)
  const days = new Set<number>(p.weekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))
  if (days.size === 0) return null
  const local = new Date(now + offsetAt(now) * 60_000)
  for (let i = 0; i <= 7; i++) {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i, hour, minute)
    const weekday = ((new Date(wall).getUTCDay() + 6) % 7) + 1
    if (!days.has(weekday)) continue
    const guess = wall - offsetAt(wall) * 60_000
    const at = wall - offsetAt(guess) * 60_000
    if (at >= now) return at
  }
  // Every weekday comes back within 7 days: only a zone jumping more than a day could get here.
  return null
}

/** The live plan that comes next, with its time; null when none is planned. */
export function nextPlanned(
  plans: readonly PlanRecord[],
  now: number,
  offsetAt: (at: number) => number = localOffset,
): { plan: PlanRecord; at: number } | null {
  let best: { plan: PlanRecord; at: number } | null = null
  for (const plan of plans) {
    const at = nextOccurrence(plan, now, offsetAt)
    if (at !== null && (best === null || at < best.at)) best = { plan, at }
  }
  return best
}

// ---- History ----

export interface SessionSummary {
  session: Session
  /** From its start to its end, or to its last review while it has no end. */
  durationMs: number
  reviews: number
  /** Distinct cards seen. */
  cards: number
  grades: Record<Rating, number>
  /** Distinct cards graded Again at least once, in the order they were first failed. */
  failed: Id[]
  /** Answer time summed over its reviews. */
  answerMs: number
}

/** Summary of a session from its non-voided reviews (any order). */
export function summarize(session: Session, reviews: readonly ReviewEvent[]): SessionSummary {
  const sorted = [...reviews].sort((a, b) => a.at - b.at || cmp(a.id, b.id))
  const grades: Record<Rating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
  const cards = new Set<Id>()
  const failed = new Set<Id>()
  let answerMs = 0
  let last = session.startedAt
  for (const r of sorted) {
    grades[r.rating]++
    cards.add(r.cardId)
    if (r.rating === 1) failed.add(r.cardId)
    answerMs += Math.max(0, r.ms)
    last = Math.max(last, r.at)
  }
  return {
    session,
    durationMs: Math.max(0, (session.endedAt ?? last) - session.startedAt),
    reviews: sorted.length,
    cards: cards.size,
    grades,
    failed: [...failed],
    answerMs,
  }
}

/** Every session with its results, newest first. Reads only. */
export function sessionHistory(ws: ModelWorkspace): SessionSummary[] {
  return ws.sessions.list().map((s) => summarize(s, ws.reviews.forSession(s.id)))
}

/**
 * Starts a new `failed` session over the cards failed in `sessionId`, same scope and mode. Null (and nothing
 * written) when none was failed.
 */
export function relaunchFailed(ws: ModelWorkspace, sessionId: Id): Id | null {
  const s = ws.sessions.get(sessionId)
  if (!s) throw new EntityNotFoundError('sessions', sessionId)
  const { failed } = summarize(s, ws.reviews.forSession(sessionId))
  if (failed.length === 0) return null
  return ws.sessions.start({ scope: s.scope, kind: 'failed', practice: s.practice, cardIds: failed })
}

export interface SessionQueueRequest {
  scope?: SessionScope
  kind: SessionKind
  limit?: number
  now: number
  practice?: boolean
  days?: number
  cardIds?: readonly Id[]
  tzOffsetMin?: number
}

/**
 * A custom session's queue over the workspace: live, unsuspended cards of live courses, those hidden in a
 * trashed subset excluded; scheduled states for the student's retention target. Reads only.
 */
export function sessionQueue(ws: ModelWorkspace, r: SessionQueueRequest): QueueEntry[] {
  const live = new Set(ws.courses.list().map((c) => c.id))
  const tree = ws.sections.tree()
  const cards = ws.cards
    .list()
    .filter((c) => live.has(c.courseId) && c.suspended !== true)
    .map((c) => ({ id: c.id, courseId: c.courseId, sections: tree.locate(c) }))
  const scheduler = createScheduler({ desiredRetention: ws.prefs.get('desiredRetention') })
  const states = new Map<Id, CardState>()
  for (const c of cards) {
    const events = ws.reviews.forCard(c.id)
    if (events.length > 0) states.set(c.id, scheduler.replay(c.id, events))
  }
  return buildSession({
    cards,
    states,
    reviews: ws.reviews.all(),
    now: r.now,
    tzOffsetMin: r.tzOffsetMin ?? localOffset(r.now),
    newPerDay: ws.prefs.get('dailyNewCards'),
    kind: r.kind,
    ...(r.scope ? { scope: r.scope } : {}),
    ...(r.limit !== undefined ? { limit: r.limit } : {}),
    ...(r.days !== undefined ? { days: r.days } : {}),
    ...(r.cardIds ? { cardIds: r.cardIds } : {}),
    practice: r.practice === true,
  })
}
