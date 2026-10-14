import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id } from '../../core/contracts/workspace'
import type { ModelWorkspace } from '../../core/model/workspace'
import { type CardState, createScheduler, dayStart, localOffset, studyDay } from '../../core/srs/fsrs'
import { buildQueue } from '../../core/srs/queue'
import { type CourseHue, courseHue } from '../components/Badges.tsx'

export interface CourseStudy {
  id: Id
  title: string
  hue: CourseHue
  /** Cards in today's queue for this course. */
  due: number
  total: number
  /** Earliest due time among its reviewed cards (null when none). */
  nextDue: number | null
}

export interface StudySummary {
  due: number
  newDue: number
  /** Estimated time for today's queue, from this student's own answer times. */
  estimateMs: number
  /** Queue size at the start of tomorrow's study day. */
  tomorrow: number
  totalCards: number
  courses: CourseStudy[]
}

/** Default seconds per card until the student has a few reviews of their own. */
const FALLBACK_MS = 10_000

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

export function computeStudy(ws: ModelWorkspace, now: number): StudySummary {
  const tz = localOffset(now)
  const courses = ws.courses.list()
  const live = new Set(courses.map((c) => c.id))
  const cards = ws.cards.list().filter((c) => live.has(c.courseId) && !c.suspended)
  const scheduler = createScheduler({ desiredRetention: ws.prefs.get('desiredRetention') })
  const states = new Map<Id, CardState>()
  const times: number[] = []
  for (const c of cards) {
    const events = ws.reviews.forCard(c.id)
    if (events.length === 0) continue
    states.set(c.id, scheduler.replay(c.id, events))
    for (const e of events) if ('ms' in e && e.ms > 0) times.push(e.ms)
  }
  const newPerDay = ws.prefs.get('dailyNewCards')
  const input = { cards: cards.map((c) => ({ id: c.id })), states, tzOffsetMin: tz, newPerDay }
  const queue = buildQueue({ ...input, now })
  const tomorrow = buildQueue({ ...input, now: dayStart(studyDay(now, tz) + 1, tz) })

  const courseOf = new Map(cards.map((c) => [c.id, c.courseId]))
  const dueBy = new Map<Id, number>()
  for (const q of queue) {
    const cid = courseOf.get(q.cardId)
    if (cid !== undefined) dueBy.set(cid, (dueBy.get(cid) ?? 0) + 1)
  }
  const totalBy = new Map<Id, number>()
  const nextBy = new Map<Id, number>()
  for (const c of cards) {
    totalBy.set(c.courseId, (totalBy.get(c.courseId) ?? 0) + 1)
    const s = states.get(c.id)
    if (s && s.phase !== 'new') nextBy.set(c.courseId, Math.min(nextBy.get(c.courseId) ?? s.due, s.due))
  }
  const perCard = Math.min(60_000, Math.max(3_000, median(times.slice(-200)) ?? FALLBACK_MS))
  const list: CourseStudy[] = courses.map((c) => ({
    id: c.id,
    title: c.title,
    hue: courseHue(c.color, c.id),
    due: dueBy.get(c.id) ?? 0,
    total: totalBy.get(c.id) ?? 0,
    nextDue: nextBy.get(c.id) ?? null,
  }))
  // Most urgent first: due today, then soonest due, then the student's own order.
  const order = new Map(courses.map((c, i) => [c.id, i]))
  list.sort(
    (a, b) =>
      Number(b.due > 0) - Number(a.due > 0) ||
      (a.nextDue ?? Number.POSITIVE_INFINITY) - (b.nextDue ?? Number.POSITIVE_INFINITY) ||
      (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  )
  return {
    due: queue.length,
    newDue: queue.filter((q) => q.kind === 'new').length,
    estimateMs: queue.length * perCard,
    tomorrow: tomorrow.length,
    totalCards: cards.length,
    courses: list,
  }
}

/** Today's study summary, recomputed whenever courses, cards, reviews or prefs change. */
export function useStudy(): StudySummary {
  return useWorkspaceData(['courses', 'cards', 'reviews', 'prefs'], (ws) => computeStudy(ws, Date.now()))
}
