import type { Id } from '../../core/contracts/workspace'
import { schedulersOf } from '../../core/model/reviewSettings'
import type { ModelWorkspace } from '../../core/model/workspace'
import { type CardState, dayStart, effectiveReviews, localOffset, newCardState, studyDay } from '../../core/srs/fsrs'
import { type DailyGoal, dailyGoal, daysUntil, type ExamPlan } from '../../core/srs/planner'
import {
  activitySplit,
  countByPhase,
  type DayActivitySplit,
  type ForecastDay,
  forecast,
  practiceRetention,
  type Retention,
  trueRetention,
} from '../../core/srs/stats'

export const WINDOW_DAYS = 30

export interface ExamRow {
  courseId: Id
  title: string
  examDate: string
  daysLeft: number
  goal: DailyGoal
}

export interface StatsData {
  /** One entry per study day of the window, oldest first (zero-filled); cramming counted apart within each. */
  days: DayActivitySplit[]
  reviews: number
  ms: number
  /** Cramming reviews among `reviews`: done, but kept out of the schedule. */
  practice: number
  /** Retention of scheduled reviews only. */
  retention: Retention
  /** Pass rate of the window's cramming reviews, apart from true retention. */
  practiceRetention: Retention
  forecast: ForecastDay[]
  phases: Record<CardState['phase'], number>
  exams: ExamRow[]
  tz: number
}

/** Exam day at local noon, so the study day is the calendar day whatever the day-start hour. */
export function examTime(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12).getTime()
}

const pick = (r: { at: number; ms: number; rating: number }) => ({ at: r.at, ms: r.ms, rating: r.rating })

export function computeStats(ws: ModelWorkspace, now: number): StatsData {
  const tz = localOffset(now)
  const courses = ws.courses.list()
  const live = new Set(courses.map((c) => c.id))
  const cards = ws.cards.list().filter((c) => live.has(c.courseId) && !c.suspended)
  const schedulerFor = schedulersOf(ws)
  const states = new Map<Id, CardState>()
  const events: { at: number; ms: number; rating: number; p?: true }[] = []
  for (const c of cards) {
    const log = ws.reviews.forCard(c.id)
    if (log.length === 0) {
      states.set(c.id, newCardState(c.id))
      continue
    }
    states.set(c.id, schedulerFor(c.courseId).replay(c.id, log))
    for (const r of effectiveReviews(log)) events.push(r.p === true ? { ...pick(r), p: true } : pick(r))
  }

  const today = studyDay(now, tz)
  const first = today - WINDOW_DAYS + 1
  const from = dayStart(first, tz)
  const byDay = new Map(activitySplit(events, tz).map((a) => [a.day, a]))
  const days = Array.from(
    { length: WINDOW_DAYS },
    (_, i) => byDay.get(first + i) ?? { day: first + i, reviews: 0, ms: 0, practice: 0, practiceMs: 0 },
  )

  const exams: ExamRow[] = []
  for (const c of courses) {
    if (!c.examDate) continue
    const plan: ExamPlan = { examAt: examTime(c.examDate), tzOffsetMin: tz }
    if (studyDay(plan.examAt, tz) < today) continue
    const own = cards.flatMap((k) => (k.courseId === c.id ? [states.get(k.id) ?? newCardState(k.id)] : []))
    exams.push({
      courseId: c.id,
      title: c.title,
      examDate: c.examDate,
      daysLeft: daysUntil(plan, now),
      goal: dailyGoal(plan, own, now),
    })
  }
  exams.sort((a, b) => a.daysLeft - b.daysLeft)

  return {
    days,
    reviews: days.reduce((n, d) => n + d.reviews, 0),
    ms: days.reduce((n, d) => n + d.ms, 0),
    practice: days.reduce((n, d) => n + d.practice, 0),
    retention: trueRetention(states.values(), from, now + 1),
    practiceRetention: practiceRetention(events, from, now + 1),
    forecast: forecast(states.values(), now, tz, 7),
    phases: countByPhase(states.values()),
    exams,
    tz,
  }
}
