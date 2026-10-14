import type { Id, Rating } from '../../core/contracts/workspace'
import { makeClozeCards } from '../../core/model/cloze'
import type { ModelWorkspace } from '../../core/model/workspace'
import { type CardState, createScheduler, dayStart, localOffset, type Scheduler, studyDay } from '../../core/srs/fsrs'
import { isLeech } from '../../core/srs/leech'
import { buildQueue } from '../../core/srs/queue'
import { examCourse } from '../../ui/data/useStudy.ts'

export const RATINGS: readonly Rating[] = [1, 2, 3, 4]

/** The scheduler for the workspace's current retention target. */
export function schedulerFor(ws: ModelWorkspace): Scheduler {
  return createScheduler({ desiredRetention: ws.prefs.get('desiredRetention') })
}

/**
 * Today's queue, fixed when the session starts so answering never reshuffles it. The course with
 * the nearest exam leads; the order within each part is the scheduler's.
 */
export function startQueue(ws: ModelWorkspace, now: number): { queue: Id[]; learning: Id[] } {
  const live = new Set(ws.courses.list().map((c) => c.id))
  const cards = ws.cards.list().filter((c) => live.has(c.courseId) && !c.suspended)
  const scheduler = schedulerFor(ws)
  const states = new Map<Id, CardState>()
  for (const c of cards) {
    const events = ws.reviews.forCard(c.id)
    if (events.length > 0) states.set(c.id, scheduler.replay(c.id, events))
  }
  const ids = buildQueue({
    cards: cards.map((c) => ({ id: c.id })),
    states,
    now,
    tzOffsetMin: localOffset(now),
    newPerDay: ws.prefs.get('dailyNewCards'),
  }).map((q) => q.cardId)
  // Cards in (re)learning: those not due yet may come back later in the session.
  const learning: Id[] = []
  for (const [id, st] of states) if (st.phase === 'learning' || st.phase === 'relearning') learning.push(id)
  const exam = examCourse(ws, now)
  if (exam === null) return { queue: ids, learning }
  const courseOf = new Map(cards.map((c) => [c.id, c.courseId]))
  const lead = ids.filter((id) => courseOf.get(id) === exam.id)
  return { queue: [...lead, ...ids.filter((id) => courseOf.get(id) !== exam.id)], learning }
}

/**
 * Cards (answered in this session, or in learning when it began) still in (re)learning and come back before the study day
 * ends, soonest first: graded Again, or on a learning step. A session is done only once they are.
 */
export function returning(ws: ModelWorkspace, candidates: Iterable<Id>, now: number): { id: Id; due: number }[] {
  const tz = localOffset(now)
  const endOfDay = dayStart(studyDay(now, tz) + 1, tz)
  const scheduler = schedulerFor(ws)
  const out: { id: Id; due: number }[] = []
  for (const id of new Set(candidates)) {
    const card = ws.cards.get(id)
    if (!card || card.deletedAt !== undefined || card.suspended) continue
    const s = scheduler.replay(id, ws.reviews.forCard(id))
    if ((s.phase === 'learning' || s.phase === 'relearning') && s.due < endOfDay) out.push({ id, due: s.due })
  }
  return out.sort((a, b) => a.due - b.due || (a.id < b.id ? -1 : 1))
}

/** One turn in the session's queue. */
export interface QueueEntry {
  id: Id
  /**
   * Set on a card appended because it came back: the review (in this session) whose grade sent it
   * back, or null for a card already in learning when the session began.
   */
  returnOf?: Id | null
}

/** Undoing a grade also takes back the returns it caused. */
export const dropReturnsOf = (queue: QueueEntry[], reviewId: Id): QueueEntry[] =>
  queue.filter((e) => e.returnOf !== reviewId)

export interface CardView {
  id: Id
  courseId: Id
  courseTitle: string
  /** BCP 47 tag of the course, for read-aloud. */
  language: string | undefined
  kind: 'basic' | 'cloze'
  /** Raw stored texts (cloze markup intact), what the AI features see. */
  rawFront: string
  rawBack: string
  /** Markdown shown before and after the reveal. */
  front: string
  back: string
  state: CardState
  leech: boolean
  /** Due time for each grade if answered at the time of reading. */
  preview: Record<Rating, number>
}

/** Everything the focus view shows for one card, read through the Workspace. */
export function readCard(ws: ModelWorkspace, id: Id, now: number): CardView | null {
  const card = ws.cards.get(id)
  if (!card || card.deletedAt !== undefined) return null
  const course = ws.courses.get(card.courseId)
  const rawFront = ws.text({ id, field: 'front' }).toString()
  const rawBack = ws.text({ id, field: 'back' }).toString()
  let front = rawFront
  let back = rawBack
  if (card.kind === 'cloze') {
    const [first] = makeClozeCards(rawFront)
    if (first) {
      front = first.front
      back = rawBack.trim() ? `${first.back}\n\n${rawBack}` : first.back
    }
  }
  const scheduler = schedulerFor(ws)
  const state = scheduler.replay(id, ws.reviews.forCard(id))
  return {
    id,
    courseId: card.courseId,
    courseTitle: course?.title ?? '',
    language: course?.language,
    kind: card.kind,
    rawFront,
    rawBack,
    front,
    back,
    state,
    leech: isLeech(state),
    preview: scheduler.previewIntervals(state, now),
  }
}

/** Plain text for speech: Markdown and cloze markers stripped. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>$~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export { formatInterval } from './interval.ts'
