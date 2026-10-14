import type { StudyScope } from '../../core/contracts/workspace'
import type { ModelWorkspace } from '../../core/model/workspace'
import { type CardState, createScheduler, localOffset } from '../../core/srs/fsrs'
import { nearestScopedExam, type ScopedExam } from '../../core/srs/planner'
import { buildQueue } from '../../core/srs/queue'
import { examTime } from '../../ui/data/useStudy.ts'

/** The nearest exam ahead among courses and their subsets (a chapter exam covers that chapter alone). */
export function nearestExamScope(ws: ModelWorkspace, now: number): { scope: StudyScope; days: number } | null {
  const tzOffsetMin = localOffset(now)
  const exams: ScopedExam[] = []
  for (const e of ws.exams()) {
    const examAt = examTime(e.examDate)
    if (examAt !== null) exams.push({ scope: e.scope, plan: { examAt, tzOffsetMin } })
  }
  const best = nearestScopedExam(exams, now)
  return best === null ? null : { scope: best.scope, days: best.days }
}

/**
 * When the nearest exam is a subset's, its share of today's queue: "incl. 12 in Contracts · D-5".
 * Null when the nearest exam is a whole course's (Today's summary already names it) or there is none.
 * The share is taken from Today's own queue (same cards, same daily new-card budget as its total), so it
 * never exceeds the total nor names a card that is not queued today. Replays come from the shared scheduler
 * cache that Today's summary already filled.
 */
export function sectionExamLead(ws: ModelWorkspace, now: number): { title: string; due: number; days: number } | null {
  const exam = nearestExamScope(ws, now)
  const sectionId = exam?.scope.sectionId
  if (exam === null || sectionId === undefined) return null
  const section = ws.sections.get(sectionId)
  if (!section) return null
  // The very input of Today's total (computeStudy): every unsuspended card of a live course.
  const live = new Set(ws.courses.list().map((c) => c.id))
  const cards = ws.cards.list().filter((c) => live.has(c.courseId) && !c.suspended)
  const scheduler = createScheduler({ desiredRetention: ws.prefs.get('desiredRetention') })
  const states = new Map<string, CardState>()
  for (const c of cards) {
    const events = ws.reviews.forCard(c.id)
    if (events.length > 0) states.set(c.id, scheduler.replay(c.id, events))
  }
  const queue = buildQueue({
    cards: cards.map((c) => ({ id: c.id })),
    states,
    now,
    tzOffsetMin: localOffset(now),
    newPerDay: ws.prefs.get('dailyNewCards'),
  })
  const inSubset = new Set(ws.scoped('cards', exam.scope).map((c) => c.id))
  const due = queue.filter((q) => inSubset.has(q.cardId)).length
  return { title: section.name, due, days: exam.days }
}
