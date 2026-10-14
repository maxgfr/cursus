import { type CardState, dayStart, type SrsParams, studyDay } from './fsrs'

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
