import {
  type FSRS,
  type Card as FsrsCard,
  fsrs,
  GenSeedStrategyWithCardId,
  type Grade,
  type RecordLogItem,
  State,
  type StepUnit,
  StrategyMode,
} from 'ts-fsrs'
import type { Id, NewReview, Rating, Review } from '../contracts/workspace'

/** A graded review event, as stored in the reviews log. */
export type GradedReview = NewReview & { id: Id; dev: string }

export type Phase = 'new' | 'learning' | 'review' | 'relearning'

export interface SrsParams {
  desiredRetention: number
  learningSteps: readonly StepUnit[]
  relearningSteps: readonly StepUnit[]
  maximumInterval: number
  enableFuzz: boolean
}

export const DEFAULT_PARAMS: SrsParams = {
  desiredRetention: 0.9,
  learningSteps: ['1m', '10m'],
  relearningSteps: ['10m'],
  maximumInterval: 36500,
  enableFuzz: true,
}

/** One replayed step: the phase the card was in when the review happened. */
export interface ReplayStep {
  reviewId: Id
  at: number
  rating: Rating
  phaseBefore: Phase
}

export interface CardState {
  cardId: Id
  phase: Phase
  /** Epoch ms when the card is next due; for a new card, 0. */
  due: number
  stability: number
  difficulty: number
  reps: number
  lapses: number
  /** Index in the (re)learning steps. */
  step: number
  lastReview: number | null
  history: readonly ReplayStep[]
}

const PHASES: Record<State, Phase> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
}

const STATES: Record<Phase, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
}

const isGraded = (r: Review): r is GradedReview => !('voids' in r)

/** Orders by (at, id), the replay order shared by every device. */
export function compareReviews(a: { at: number; id: Id }, b: { at: number; id: Id }): number {
  if (a.at !== b.at) return a.at - b.at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Drops voided reviews, sorts by (at, id) and clamps time so it never goes
 * backwards (negative elapsed time becomes 0).
 */
export function effectiveReviews(events: readonly Review[]): GradedReview[] {
  const voided = new Set<Id>()
  for (const e of events) if (!isGraded(e)) voided.add(e.voids)
  const graded = events.filter(isGraded).filter((r) => !voided.has(r.id))
  graded.sort(compareReviews)
  let last = Number.NEGATIVE_INFINITY
  return graded.map((r) => {
    const at = Math.max(r.at, last)
    last = at
    return at === r.at ? r : { ...r, at }
  })
}

/** Groups effective reviews per card (already sorted and clamped). */
export function reviewsByCard(events: readonly Review[]): Map<Id, GradedReview[]> {
  const out = new Map<Id, GradedReview[]>()
  for (const r of effectiveReviews(events)) {
    const list = out.get(r.cardId)
    if (list) list.push(r)
    else out.set(r.cardId, [r])
  }
  return out
}

export function newCardState(cardId: Id): CardState {
  return {
    cardId,
    phase: 'new',
    due: 0,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    step: 0,
    lastReview: null,
    history: [],
  }
}

function toState(cardId: Id, card: FsrsCard, history: ReplayStep[]): CardState {
  return {
    cardId,
    phase: PHASES[card.state],
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    step: card.learning_steps,
    lastReview: card.last_review ? card.last_review.getTime() : null,
    history,
  }
}

function toFsrsCard(s: CardState): FsrsCard & { cardId: Id } {
  const last = s.lastReview === null ? undefined : new Date(s.lastReview)
  return {
    cardId: s.cardId,
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: s.step,
    reps: s.reps,
    lapses: s.lapses,
    state: STATES[s.phase],
    ...(last ? { last_review: last } : {}),
  }
}

export interface Scheduler {
  readonly params: SrsParams
  /** Replays a card's reviews (any order, voids included) into its current state. Cached by (cardId, count, reviews). */
  replay(cardId: Id, events: readonly Review[]): CardState
  /** Replays every card present in the log. */
  replayAll(events: readonly Review[]): Map<Id, CardState>
  /** Next due time for each rating if the card were reviewed at `now`. */
  previewIntervals(state: CardState, now: number): Record<Rating, number>
}

export function createScheduler(params: Partial<SrsParams> = {}): Scheduler {
  const p: SrsParams = { ...DEFAULT_PARAMS, ...params }
  const engine: FSRS = fsrs({
    request_retention: p.desiredRetention,
    maximum_interval: p.maximumInterval,
    enable_fuzz: p.enableFuzz,
    enable_short_term: true,
    learning_steps: p.learningSteps,
    relearning_steps: p.relearningSteps,
  }).useStrategy(StrategyMode.SEED, GenSeedStrategyWithCardId('cardId'))
  const cache = new Map<string, CardState>()

  const replaySorted = (cardId: Id, reviews: readonly GradedReview[]): CardState => {
    if (reviews.length === 0) return newCardState(cardId)
    // Keyed by (cardId, count) plus a fingerprint of the exact reviews, so a
    // merge that swaps an earlier review never returns a stale state.
    const key = `${cardId}\u0000${reviews.length}\u0000${reviews.map((r) => `${r.id}:${r.at}:${r.rating}`).join(',')}`
    const hit = cache.get(key)
    if (hit) return hit
    // Step-by-step with a card carrying `cardId`, so the fuzz seed is per card
    // and identical to the one previewIntervals uses.
    let card: FsrsCard & { cardId: Id } = newCardFsrs(cardId, reviews[0] as GradedReview)
    const steps: ReplayStep[] = []
    for (const r of reviews) {
      const item: RecordLogItem = engine.next(card, new Date(r.at), r.rating as Grade)
      steps.push({ reviewId: r.id, at: r.at, rating: r.rating, phaseBefore: PHASES[item.log.state] })
      card = { ...item.card, cardId }
    }
    const final = card
    const state = toState(cardId, final, steps)
    cache.set(key, state)
    return state
  }

  return {
    params: p,
    replay(cardId, events) {
      return replaySorted(
        cardId,
        effectiveReviews(events).filter((r) => r.cardId === cardId),
      )
    },
    replayAll(events) {
      const out = new Map<Id, CardState>()
      for (const [cardId, list] of reviewsByCard(events)) out.set(cardId, replaySorted(cardId, list))
      return out
    },
    previewIntervals(state, now) {
      const preview = engine.repeat(toFsrsCard(state), new Date(now))
      return {
        1: preview[1].card.due.getTime(),
        2: preview[2].card.due.getTime(),
        3: preview[3].card.due.getTime(),
        4: preview[4].card.due.getTime(),
      }
    },
  }
}

function newCardFsrs(cardId: Id, first: GradedReview): FsrsCard & { cardId: Id } {
  return { ...toFsrsCard(newCardState(cardId)), due: new Date(first.at) }
}

// ---- Day boundaries ----

export const DAY_MS = 86_400_000
export const DAY_START_HOUR = 4

/**
 * Index of the study day containing `at`. A study day starts at 04:00 local
 * time; `tzOffsetMin` is minutes east of UTC (e.g. +120 for CEST).
 */
export function studyDay(at: number, tzOffsetMin: number): number {
  return Math.floor((at + tzOffsetMin * 60_000 - DAY_START_HOUR * 3_600_000) / DAY_MS)
}

/** Epoch ms at which study day `day` starts. */
export function dayStart(day: number, tzOffsetMin: number): number {
  return day * DAY_MS + DAY_START_HOUR * 3_600_000 - tzOffsetMin * 60_000
}

/** Offset (minutes east of UTC) of the runtime's local zone at `at`. */
export function localOffset(at: number): number {
  return -new Date(at).getTimezoneOffset()
}
