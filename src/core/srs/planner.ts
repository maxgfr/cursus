import type { Id, StudyScope } from '../contracts/workspace'
import { type CardState, dayStart, newCardState, type SrsParams, studyDay } from './fsrs'
import { inScope, type QueueCard } from './queue'

export const EXAM_RETENTION = 0.95
export const EXAM_WINDOW_DAYS = 7

export interface ExamPlan {
  examAt: number
  tzOffsetMin: number
}

/** Study days left before the exam day (0 on exam day or after). */
export function daysUntil(plan: ExamPlan, now: number): number {
  return Math.max(0, studyDay(plan.examAt, plan.tzOffsetMin) - studyDay(now, plan.tzOffsetMin))
}

/** Parameters for today: retention rises to 0.95 during the 7 days before the exam. */
export function paramsFor(base: SrsParams, plan: ExamPlan | null, now: number): SrsParams {
  if (!plan) return base
  const left = daysUntil(plan, now)
  if (left <= 0 || left > EXAM_WINDOW_DAYS) return base
  return { ...base, desiredRetention: Math.max(base.desiredRetention, EXAM_RETENTION) }
}

export interface DailyGoal {
  /** New cards to introduce today so every card is seen before the exam. */
  newCards: number
  /** Cards already due by the end of today. */
  dueCards: number
  total: number
}

/**
 * Daily goal: spread the unseen cards over the remaining days (keeping the
 * final window for consolidation when possible) and add today's due cards.
 */
export function dailyGoal(plan: ExamPlan, states: readonly CardState[], now: number): DailyGoal {
  const endOfDay = dayStart(studyDay(now, plan.tzOffsetMin) + 1, plan.tzOffsetMin)
  let unseen = 0
  let dueCards = 0
  for (const s of states) {
    if (s.phase === 'new') unseen++
    else if (s.due < endOfDay) dueCards++
  }
  const left = daysUntil(plan, now)
  const learnDays = left > EXAM_WINDOW_DAYS ? left - EXAM_WINDOW_DAYS : Math.max(1, left)
  const newCards = Math.ceil(unseen / learnDays)
  return { newCards, dueCards, total: newCards + dueCards }
}

export interface ExamCandidate {
  id: string
  plan: ExamPlan
}

/**
 * The course whose exam comes first, today included; exams already past are ignored.
 * Ties keep the given order. Null when no course has an exam ahead.
 */
export function nearestExam(candidates: readonly ExamCandidate[], now: number): { id: string; days: number } | null {
  let best: { id: string; days: number } | null = null
  for (const c of candidates) {
    if (studyDay(c.plan.examAt, c.plan.tzOffsetMin) < studyDay(now, c.plan.tzOffsetMin)) continue
    const days = daysUntil(c.plan, now)
    if (best === null || days < best.days) best = { id: c.id, days }
  }
  return best
}

/** An exam set on a course or on one of its subsets (a chapter exam covers that chapter and its descendants). */
export interface ScopedExam {
  scope: StudyScope
  plan: ExamPlan
}

/** The nearest deadline among these exams, today included, past ones ignored; ties keep the given order. */
export function nearestScopedExam(
  exams: readonly ScopedExam[],
  now: number,
): { scope: StudyScope; plan: ExamPlan; days: number } | null {
  const best = nearestExam(
    exams.map((e, i) => ({ id: String(i), plan: e.plan })),
    now,
  )
  const exam = best === null ? undefined : exams[Number(best.id)]
  return best === null || exam === undefined ? null : { scope: exam.scope, plan: exam.plan, days: best.days }
}

/** A course's deadline: the nearest exam among the course itself and all its subsets. */
export function courseDeadline(
  exams: readonly ScopedExam[],
  courseId: Id,
  now: number,
): { scope: StudyScope; plan: ExamPlan; days: number } | null {
  return nearestScopedExam(
    exams.filter((e) => e.scope.courseId === courseId),
    now,
  )
}

/** The nearest exam that covers this card (its course's, or one of the subsets it is filed under). */
export function examFor(card: QueueCard, exams: readonly ScopedExam[], now: number): ScopedExam | null {
  const best = nearestScopedExam(
    exams.filter((e) => inScope(card, e.scope)),
    now,
  )
  return best === null ? null : { scope: best.scope, plan: best.plan }
}

/** Daily goal for one exam: only the cards in its scope count, so a chapter exam plans that chapter alone. */
export function scopedDailyGoal(
  exam: ScopedExam,
  cards: readonly QueueCard[],
  states: ReadonlyMap<Id, CardState>,
  now: number,
): DailyGoal {
  const own: CardState[] = []
  for (const c of cards) if (inScope(c, exam.scope)) own.push(states.get(c.id) ?? newCardState(c.id))
  return dailyGoal(exam.plan, own, now)
}
