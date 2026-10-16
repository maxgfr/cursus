import type { Id, Rating, StudyScope } from '../../core/contracts/workspace'
import { clozeFaces, makeClozeCards } from '../../core/model/cloze'
import { queueLimitsFor, schedulerOf } from '../../core/model/reviewSettings'
import type { ModelWorkspace } from '../../core/model/workspace'
import { type CardState, dayStart, localOffset, type Scheduler, studyDay } from '../../core/srs/fsrs'
import { isLeech } from '../../core/srs/leech'
import { buildQueue, inScope, type QueueCard } from '../../core/srs/queue'
import { nearestExamScope } from '../Today/sectionLead.ts'

export const RATINGS: readonly Rating[] = [1, 2, 3, 4]

/** The scheduler of the workspace's review settings. */
export function schedulerFor(ws: ModelWorkspace): Scheduler {
  return schedulerOf(ws)
}

/** Live, unsuspended cards with what a scoped queue needs: their course and the sections they are filed under. */
export function queueCards(ws: ModelWorkspace): (QueueCard & { courseId: Id })[] {
  const live = new Set(ws.courses.list().map((c) => c.id))
  const tree = ws.sections.tree()
  return ws.cards
    .list()
    .filter((c) => live.has(c.courseId) && !c.suspended)
    .map((c) => ({ id: c.id, courseId: c.courseId, sections: tree.locate(c) }))
}

/**
 * Today's queue, fixed when the session starts so answering never reshuffles it. With a scope, only that
 * course or subset (descendants included). The nearest exam's cards lead; the order within each part is the
 * scheduler's.
 */
export function startQueue(ws: ModelWorkspace, now: number, scope?: StudyScope): { queue: Id[]; learning: Id[] } {
  const cards = queueCards(ws)
  const scheduler = schedulerFor(ws)
  const states = new Map<Id, CardState>()
  for (const c of cards) {
    const events = ws.reviews.forCard(c.id)
    if (events.length > 0) states.set(c.id, scheduler.replay(c.id, events))
  }
  const ids = buildQueue({
    cards,
    states,
    now,
    tzOffsetMin: localOffset(now),
    ...queueLimitsFor(ws),
    scope,
  }).map((q) => q.cardId)
  // Cards in (re)learning: those not due yet may come back later in the session.
  const learning: Id[] = []
  const queued = new Set(cards.filter((c) => inScope(c, scope)).map((c) => c.id))
  for (const [id, st] of states)
    if ((st.phase === 'learning' || st.phase === 'relearning') && queued.has(id)) learning.push(id)
  const exam = nearestExamScope(ws, now)
  if (exam === null) return { queue: ids, learning }
  const byId = new Map(cards.map((c) => [c.id, c]))
  const leads = (id: Id) => {
    const c = byId.get(id)
    return c !== undefined && inScope(c, exam.scope)
  }
  return { queue: [...ids.filter(leads), ...ids.filter((id) => !leads(id))], learning }
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
  /** The question and the answer as text (cloze deletions resolved), what speech and the AI features read. */
  front: string
  back: string
  /** The Markdown rendered before and after the reveal: a cloze card's deletions marked, as its editor draws them. */
  shown: { front: string; back: string }
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
  const events = ws.reviews.forCard(id)
  let front = rawFront
  let back = rawBack
  let shown = { front, back }
  if (card.kind === 'cloze') {
    // One schedule per card: its blanks are asked in turn, one per review, so each is tested (c1, then c2…).
    const blanks = makeClozeCards(rawFront)
    const asked = blanks[events.length % Math.max(1, blanks.length)]
    if (asked) {
      const extra = (answer: string) => (rawBack.trim() ? `${answer}\n\n${rawBack}` : answer)
      front = asked.front
      back = extra(asked.back)
      const faces = clozeFaces(rawFront, asked.index)
      shown = { front: faces.front, back: extra(faces.back) }
    }
  }
  const scheduler = schedulerFor(ws)
  const state = scheduler.replay(id, events)
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
    shown,
    state,
    leech: isLeech(state, ws.reviewSettings.get().leechThreshold),
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
