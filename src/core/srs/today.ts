import type { Id } from '../contracts/workspace'
import { type CardState, dayStart, retrievability, studyDay } from './fsrs'
import { EXAM_WINDOW_DAYS } from './planner'
import type { QueueEntry } from './queue'

/*
 * Today, course by course: a reading of today's queue (built once, with the daily limits and the new-card budget of
 * every course together), never a queue of its own. Each course gets its share of that queue, what makes it urgent,
 * and a place in the order: an exam within the exam window first, then the most behind, then the most fragile, then
 * the most reviews, then new cards only. Nothing here schedules a card or changes what the queue holds.
 */

/** A queued card is fragile below this chance of recall… */
export const FRAGILE_RECALL = 0.7
/** …or once forgotten this often. */
export const FRAGILE_LAPSES = 3

/** Why a course comes where it does, in order of precedence: what Today says under its name. */
export type TodayReason =
  | { kind: 'exam'; days: number }
  | { kind: 'late'; count: number }
  | { kind: 'fragile'; count: number }
  | { kind: 'due'; count: number }
  | { kind: 'new'; count: number }

/** A course's share of today's queue. */
export interface CourseToday {
  courseId: Id
  /** Its cards in today's queue: `learning + review + fresh`. */
  total: number
  learning: number
  review: number
  fresh: number
  /** Reviews that were due before today's study day began. */
  late: number
  /** Queued cards (new ones aside) unlikely to be recalled, or often forgotten. */
  fragile: number
  /** Study days to its nearest exam ahead (its own or a subset's); null without one. */
  examDays: number | null
  reason: TodayReason
}

export interface TodayInput {
  /** The courses, in the student's order (ties keep it). */
  courses: readonly Id[]
  /** Each queued card's course. */
  courseOf: ReadonlyMap<Id, Id>
  /** Today's queue, as `buildQueue` gave it. */
  queue: readonly QueueEntry[]
  /** Scheduled states; a card without one was never reviewed. */
  states: ReadonlyMap<Id, CardState>
  /** Study days to each course's nearest exam ahead (today: 0); past exams are left out. */
  exams: ReadonlyMap<Id, number>
  now: number
  tzOffsetMin: number
}

const TIERS: readonly TodayReason['kind'][] = ['exam', 'late', 'fragile', 'due', 'new']

function reasonOf(c: Omit<CourseToday, 'reason'>): TodayReason {
  if (c.examDays !== null && c.examDays <= EXAM_WINDOW_DAYS) return { kind: 'exam', days: c.examDays }
  if (c.late > 0) return { kind: 'late', count: c.late }
  if (c.fragile > 0) return { kind: 'fragile', count: c.fragile }
  if (c.learning + c.review > 0) return { kind: 'due', count: c.learning + c.review }
  return { kind: 'new', count: c.fresh }
}

/** Within a tier: the nearest exam first, else the largest count. */
const urgency = (r: TodayReason): number => (r.kind === 'exam' ? r.days : -r.count)

/** The courses with work in today's queue, most urgent first, each with its share and its reason. */
export function planToday(i: TodayInput): CourseToday[] {
  const startOfDay = dayStart(studyDay(i.now, i.tzOffsetMin), i.tzOffsetMin)
  const order = new Map<Id, number>()
  for (const id of i.courses) if (!order.has(id)) order.set(id, order.size)
  const by = new Map<Id, Omit<CourseToday, 'reason'>>()
  for (const q of i.queue) {
    const courseId = i.courseOf.get(q.cardId)
    if (courseId === undefined || !order.has(courseId)) continue
    let c = by.get(courseId)
    if (!c) {
      const exam = i.exams.get(courseId)
      c = {
        courseId,
        total: 0,
        learning: 0,
        review: 0,
        fresh: 0,
        late: 0,
        fragile: 0,
        examDays: exam === undefined || exam < 0 ? null : exam,
      }
      by.set(courseId, c)
    }
    c.total++
    if (q.kind === 'new') {
      c.fresh++
      continue
    }
    if (q.kind === 'learning') c.learning++
    else c.review++
    const s = i.states.get(q.cardId)
    if (s === undefined) continue
    if (q.kind === 'review' && s.due < startOfDay) c.late++
    if (s.lapses >= FRAGILE_LAPSES || retrievability(s, i.now) < FRAGILE_RECALL) c.fragile++
  }
  const out = [...by.values()].map((c) => ({ ...c, reason: reasonOf(c) }))
  return out.sort(
    (a, b) =>
      TIERS.indexOf(a.reason.kind) - TIERS.indexOf(b.reason.kind) ||
      urgency(a.reason) - urgency(b.reason) ||
      (order.get(a.courseId) ?? 0) - (order.get(b.courseId) ?? 0),
  )
}

/**
 * Today's queue in that order: cards on a (re)learning step first (their step is due now), then course by course,
 * each course's cards in the queue's own order. Same cards, same count.
 */
export function inTodayOrder<T extends QueueEntry>(
  queue: readonly T[],
  plan: readonly Pick<CourseToday, 'courseId'>[],
  courseOf: ReadonlyMap<Id, Id>,
): T[] {
  const rank = new Map(plan.map((c, n) => [c.courseId, n]))
  const rankOf = (q: T): number => {
    if (q.kind === 'learning') return -1
    const courseId = courseOf.get(q.cardId)
    return (courseId === undefined ? undefined : rank.get(courseId)) ?? plan.length
  }
  // A stable sort: the queue's order holds within each group.
  return queue
    .map((q, n) => ({ q, n, r: rankOf(q) }))
    .sort((a, b) => a.r - b.r || a.n - b.n)
    .map((x) => x.q)
}
