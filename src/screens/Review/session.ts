import type { Id, Rating } from '../../core/contracts/workspace'
import { makeClozeCards } from '../../core/model/cloze'
import type { ModelWorkspace } from '../../core/model/workspace'
import { type CardState, createScheduler, localOffset, type Scheduler } from '../../core/srs/fsrs'
import { isLeech } from '../../core/srs/leech'
import { buildQueue } from '../../core/srs/queue'

export const RATINGS: readonly Rating[] = [1, 2, 3, 4]

/** The scheduler for the workspace's current retention target. */
export function schedulerFor(ws: ModelWorkspace): Scheduler {
  return createScheduler({ desiredRetention: ws.prefs.get('desiredRetention') })
}

/** Today's queue, frozen when the session starts so answering never reshuffles it. */
export function startQueue(ws: ModelWorkspace, now: number): Id[] {
  const live = new Set(ws.courses.list().map((c) => c.id))
  const cards = ws.cards.list().filter((c) => live.has(c.courseId) && !c.suspended)
  const scheduler = schedulerFor(ws)
  const states = new Map<Id, CardState>()
  for (const c of cards) {
    const events = ws.reviews.forCard(c.id)
    if (events.length > 0) states.set(c.id, scheduler.replay(c.id, events))
  }
  return buildQueue({
    cards: cards.map((c) => ({ id: c.id })),
    states,
    now,
    tzOffsetMin: localOffset(now),
    newPerDay: ws.prefs.get('dailyNewCards'),
  }).map((q) => q.cardId)
}

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

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Short, locale-aware interval ("10 min", "3 days", "2 mo"). */
export function formatInterval(ms: number, tag: string): string {
  const unit = (value: number, u: 'minute' | 'hour' | 'day' | 'month' | 'year') =>
    new Intl.NumberFormat(tag, { style: 'unit', unit: u, unitDisplay: 'short', maximumFractionDigits: 1 }).format(value)
  if (ms < HOUR) return unit(Math.max(1, Math.round(ms / MINUTE)), 'minute')
  if (ms < DAY) return unit(Math.round(ms / HOUR), 'hour')
  const days = Math.round(ms / DAY)
  if (days < 31) return unit(days, 'day')
  if (days < 365) return unit(Math.round(days / 30.4), 'month')
  return unit(Math.round((days / 365) * 10) / 10, 'year')
}
