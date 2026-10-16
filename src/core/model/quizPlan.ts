import type { Id, StudyScope } from '../contracts/workspace'
import { type CardState, retrievability } from '../srs/fsrs'
import { schedulerOf } from './reviewSettings'
import type { ModelWorkspace } from './workspace'

/**
 * What « Quiz me » starts from on a course or a section: the cards the student struggles with there (asked
 * about first when the weak points are on), and how many questions its material is worth. Reads only.
 */

/** Below this chance of recalling a card now, it counts as a weak point. */
export const WEAK_RECALL = 0.7
/** A lapse this recent says the weak points are worth asking about by default. */
export const RECENT_LAPSE_MS = 30 * 24 * 3600_000
/** Weak points handed to the quiz at most (the fronts go into the prompt). */
export const WEAK_MAX = 8
const FRONT_CHARS = 200

export interface WeakCard {
  id: Id
  front: string
  lapses: number
  /** Chance of recalling it now (0–1). */
  recall: number
  lastReview: number | null
}

/**
 * The cards of `scope` the student struggles with: forgotten at least once (a lapse, or « Again » the last time),
 * or likely forgotten by now, most lapses then lowest recall first. Suspended cards and new ones (never reviewed)
 * are left out.
 */
export function weakCards(ws: ModelWorkspace, scope: StudyScope, now: number, limit = WEAK_MAX): WeakCard[] {
  const scheduler = schedulerOf(ws)
  const out: WeakCard[] = []
  for (const card of ws.scoped('cards', scope)) {
    if (card.suspended === true) continue
    const events = ws.reviews.forCard(card.id)
    const last = events.findLast((e) => 'rating' in e)
    if (!last || !('rating' in last)) continue
    const state: CardState = scheduler.replay(card.id, events)
    const recall = state.phase === 'review' ? retrievability(state, now) : 1
    const lapses = state.lapses + (last.rating === 1 && state.phase !== 'relearning' ? 1 : 0)
    if (lapses === 0 && recall >= WEAK_RECALL) continue
    const front = ws.text({ id: card.id, field: 'front' }).toString().trim().replace(/\s+/g, ' ').slice(0, FRONT_CHARS)
    if (front === '') continue
    out.push({ id: card.id, front, lapses, recall, lastReview: state.lastReview ?? last.at })
  }
  return out.sort((a, b) => b.lapses - a.lapses || a.recall - b.recall || (a.id < b.id ? -1 : 1)).slice(0, limit)
}

/** Whether the weak points are on by default: a card of the place was forgotten lately. */
export function failedLately(weak: readonly WeakCard[], now: number): boolean {
  return weak.some((w) => w.lapses > 0 && w.lastReview !== null && now - w.lastReview <= RECENT_LAPSE_MS)
}

/** The counts the quiz offers; `'all'` covers the material, up to the quiz's own maximum. */
export const QUIZ_COUNTS = [3, 5, 10, 20, 'all'] as const
export type QuizCount = (typeof QUIZ_COUNTS)[number]

/** What a quiz asks by default: everything its material covers, up to the quiz's own maximum. */
export const QUIZ_DEFAULT_COUNT: QuizCount = 'all'

/** How many questions a place's material is worth, from its number of passages. */
export function defaultQuizCount(passages: number): 3 | 5 | 10 | 20 {
  if (passages <= 2) return 3
  if (passages <= 6) return 5
  if (passages <= 15) return 10
  return 20
}

/** Characters of a note that make about one passage (what a quiz question can draw on). */
const PASSAGE_CHARS = 1200

/**
 * An estimate of a place's passages without reading its files: a note by its length, a deck or a document by its
 * units when they are known (else a handful), a photo or a plain file as one.
 */
export function passagesOf(ws: ModelWorkspace, scope: StudyScope): number {
  let n = 0
  for (const s of ws.scoped('sources', scope)) {
    if (s.kind === 'note') n += Math.ceil(ws.text({ id: s.id, field: 'body' }).length / PASSAGE_CHARS)
    else if (s.support !== undefined || s.kind === 'pdf') n += 5
    else n += 1
  }
  return n
}
