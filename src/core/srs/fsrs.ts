import {
  default_w,
  type FSRS,
  type Card as FsrsCard,
  forgetting_curve,
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

/** A practice (cram) review: it counts in the statistics but never in the FSRS schedule. */
export const isPractice = (r: Review): boolean => 'p' in r && r.p === true

/** Effective reviews that drive the schedule: practice reviews left out. */
export function scheduledReviews(events: readonly Review[]): GradedReview[] {
  return effectiveReviews(events).filter((r) => r.p !== true)
}

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
  // Fast path: the log is usually already in replay order with no voids and no clock skew.
  let ordered = true
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as Review
    const prev = events[i - 1]
    if (!isGraded(e) || (prev !== undefined && compareReviews(prev as GradedReview, e) >= 0)) {
      ordered = false
      break
    }
  }
  if (ordered) return events.slice() as GradedReview[]
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

/** Groups effective reviews per card (already sorted and clamped); `scheduled` leaves practice reviews out. */
export function reviewsByCard(events: readonly Review[], o: { scheduled?: boolean } = {}): Map<Id, GradedReview[]> {
  const out = new Map<Id, GradedReview[]>()
  for (const r of o.scheduled === true ? scheduledReviews(events) : effectiveReviews(events)) {
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
  /**
   * Replays a card's reviews (any order, voids included) into its current state. Practice reviews are left out
   * before anything else, so they never reach the cache fingerprint. Cached by (cardId, count, reviews).
   */
  replay(cardId: Id, events: readonly Review[]): CardState
  /** Replays every card with at least one scheduled (non-practice) review in the log. */
  replayAll(events: readonly Review[]): Map<Id, CardState>
  /** Next due time for each rating if the card were reviewed at `now`. */
  previewIntervals(state: CardState, now: number): Record<Rating, number>
  /** Every cached replay in a compact form a device can keep between launches. */
  snapshot(): ReplaySnapshot
  /**
   * Seeds the cache from a snapshot taken earlier (ignored when the parameters differ). An entry is used
   * only when its fingerprint matches the card's current reviews, so results never change.
   */
  restore(snapshot: ReplaySnapshot): void
  /** Counts replays computed by the engine (not served from the cache): a changed count means a new snapshot. */
  readonly replays: number
}

/** Cached replays, columnar: NUMS numbers per card, plus the phase before each review as one letter. */
export interface ReplaySnapshot {
  v: 1
  params: string
  ids: Id[]
  lastIds: Id[]
  phases: string[]
  nums: Float64Array
}

const NUMS = 13
const PHASE_CODE: Record<Phase, string> = { new: 'n', learning: 'l', review: 'r', relearning: 'x' }
const CODE_PHASE: Record<string, Phase> = { n: 'new', l: 'learning', r: 'review', x: 'relearning' }

/** Cached replay of one card: enough to recognise the same history, or the same history with reviews appended. */
interface Replayed {
  count: number
  lastId: Id
  lastAt: number
  /** Numeric fingerprint of every (at, rating) in order. */
  hash: number
  card: FsrsCard & { cardId: Id }
  state: CardState
}

const HASH_MOD = 4_294_967_291
const step = (h: number, r: GradedReview): number => (h * 31 + (r.at % 1_000_000_007) * 4 + r.rating) % HASH_MOD

/** One scheduler (engine and replay cache) per parameter set, shared by every screen. */
const schedulers = new Map<string, Scheduler>()

/** The key of a parameter set: two sets with the same key schedule alike. */
export function paramsKey(p: SrsParams): string {
  return JSON.stringify([p.desiredRetention, p.learningSteps, p.relearningSteps, p.maximumInterval, p.enableFuzz])
}

/** An FSRS engine for these parameters, the fuzz seeded by card id; nothing is cached (see `createScheduler`). */
export function createEngine(p: SrsParams): FSRS {
  return fsrs({
    request_retention: p.desiredRetention,
    maximum_interval: p.maximumInterval,
    enable_fuzz: p.enableFuzz,
    enable_short_term: true,
    learning_steps: p.learningSteps,
    relearning_steps: p.relearningSteps,
  }).useStrategy(StrategyMode.SEED, GenSeedStrategyWithCardId('cardId'))
}

/** Next due time for each rating if a card in `state` were reviewed at `now` by `engine`. */
export function previewWith(engine: FSRS, state: CardState, now: number): Record<Rating, number> {
  const preview = engine.repeat(toFsrsCard(state), new Date(now))
  return {
    1: preview[1].card.due.getTime(),
    2: preview[2].card.due.getTime(),
    3: preview[3].card.due.getTime(),
    4: preview[4].card.due.getTime(),
  }
}

export function createScheduler(params: Partial<SrsParams> = {}): Scheduler {
  const p: SrsParams = { ...DEFAULT_PARAMS, ...params }
  const id = paramsKey(p)
  const existing = schedulers.get(id)
  if (existing) return existing
  const engine = createEngine(p)
  const cache = new Map<Id, Replayed>()
  let replays = 0
  let seed: { snap: ReplaySnapshot; at: Map<Id, number> } | null = null

  /** Rebuilds a cached replay from the snapshot row of `cardId`, given the reviews it covered. */
  const fromSeed = (cardId: Id, reviews: readonly GradedReview[]): Replayed | undefined => {
    const row = seed?.at.get(cardId)
    if (seed === null || row === undefined) return undefined
    const { nums, lastIds, phases } = seed.snap
    const o = row * NUMS
    const count = nums[o] as number
    const codes = phases[row] as string
    if (count > reviews.length || codes.length !== count) return undefined
    const lastReview = nums[o + 12] as number
    const card: FsrsCard & { cardId: Id } = {
      cardId,
      due: new Date(nums[o + 3] as number),
      stability: nums[o + 4] as number,
      difficulty: nums[o + 5] as number,
      elapsed_days: nums[o + 6] as number,
      scheduled_days: nums[o + 7] as number,
      learning_steps: nums[o + 8] as number,
      reps: nums[o + 9] as number,
      lapses: nums[o + 10] as number,
      state: nums[o + 11] as State,
      ...(lastReview >= 0 ? { last_review: new Date(lastReview) } : {}),
    }
    const history: ReplayStep[] = []
    for (let i = 0; i < count; i++) {
      const r = reviews[i] as GradedReview
      history.push({ reviewId: r.id, at: r.at, rating: r.rating, phaseBefore: CODE_PHASE[codes[i] as string] as Phase })
    }
    const lastId = lastIds[row] as Id
    return {
      count,
      lastId,
      lastAt: nums[o + 1] as number,
      hash: nums[o + 2] as number,
      card,
      state: toState(cardId, card, history),
    }
  }

  const replaySorted = (cardId: Id, reviews: readonly GradedReview[]): CardState => {
    if (reviews.length === 0) return newCardState(cardId)
    // Fingerprint (count, last review, hash of every time and rating): a merge that swaps or
    // inserts an earlier review never returns a stale state, and appended reviews resume
    // from the cached card instead of replaying from the start.
    const hit = cache.get(cardId) ?? fromSeed(cardId, reviews)
    let hash = 0
    let from = 0
    let card: FsrsCard & { cardId: Id } = newCardFsrs(cardId, reviews[0] as GradedReview)
    let steps: ReplayStep[] = []
    if (hit && hit.count <= reviews.length) {
      const cached = hit.state.history
      // The hash covers times and ratings only: an earlier review replaced by another with the same time and
      // rating (one voided, another merged) keeps the schedule but not the history, which names each review.
      let renamed = false
      for (let i = 0; i < hit.count; i++) {
        const r = reviews[i] as GradedReview
        hash = step(hash, r)
        if ((cached[i] as ReplayStep).reviewId !== r.id) renamed = true
      }
      const at = reviews[hit.count - 1] as GradedReview
      if (hash === hit.hash && at.id === hit.lastId && at.at === hit.lastAt) {
        const history = renamed ? cached.map((h, i) => ({ ...h, reviewId: (reviews[i] as GradedReview).id })) : cached
        if (hit.count === reviews.length) {
          const same = renamed ? { ...hit, state: { ...hit.state, history } } : hit
          cache.set(cardId, same)
          return same.state
        }
        steps = history.slice()
        from = hit.count
        card = hit.card
      } else hash = 0
    }
    // Step-by-step with a card carrying `cardId`, so the fuzz seed is per card
    // and identical to the one previewIntervals uses.
    for (let i = from; i < reviews.length; i++) {
      const r = reviews[i] as GradedReview
      hash = step(hash, r)
      const item: RecordLogItem = engine.next(card, new Date(r.at), r.rating as Grade)
      steps.push({ reviewId: r.id, at: r.at, rating: r.rating, phaseBefore: PHASES[item.log.state] })
      const next = item.card as FsrsCard & { cardId: Id }
      next.cardId = cardId
      card = next
    }
    const last = reviews[reviews.length - 1] as GradedReview
    replays++
    const state = toState(cardId, card, steps)
    cache.set(cardId, { count: reviews.length, lastId: last.id, lastAt: last.at, hash, card, state })
    return state
  }

  const snapshot = (): ReplaySnapshot => {
    const ids: Id[] = []
    const lastIds: Id[] = []
    const phases: string[] = []
    const nums = new Float64Array(cache.size * NUMS)
    for (const [cardId, e] of cache) {
      const o = ids.length * NUMS
      ids.push(cardId)
      lastIds.push(e.lastId)
      let codes = ''
      for (const h of e.state.history) codes += PHASE_CODE[h.phaseBefore]
      phases.push(codes)
      const c = e.card
      nums.set(
        [
          e.count,
          e.lastAt,
          e.hash,
          c.due.getTime(),
          c.stability,
          c.difficulty,
          c.elapsed_days,
          c.scheduled_days,
          c.learning_steps,
          c.reps,
          c.lapses,
          c.state,
          c.last_review ? c.last_review.getTime() : -1,
        ],
        o,
      )
    }
    return { v: 1, params: id, ids, lastIds, phases, nums }
  }
  const restore = (snap: ReplaySnapshot): void => {
    if (snap.v !== 1 || snap.params !== id) return
    seed = { snap, at: new Map(snap.ids.map((cardId, i) => [cardId, i])) }
  }
  const scheduler: Scheduler = {
    params: p,
    snapshot,
    restore,
    get replays() {
      return replays
    },
    replay(cardId, events) {
      return replaySorted(
        cardId,
        scheduledReviews(events).filter((r) => r.cardId === cardId),
      )
    },
    replayAll(events) {
      const out = new Map<Id, CardState>()
      for (const [cardId, list] of reviewsByCard(events, { scheduled: true }))
        out.set(cardId, replaySorted(cardId, list))
      return out
    },
    previewIntervals(state, now) {
      return previewWith(engine, state, now)
    },
  }
  schedulers.set(id, scheduler)
  return scheduler
}

/**
 * Estimated probability of recalling the card at `now` (FSRS forgetting curve, default weights); 0 for a card
 * never reviewed.
 */
export function retrievability(state: CardState, now: number): number {
  if (state.phase === 'new' || state.lastReview === null || state.stability <= 0) return 0
  return forgetting_curve(default_w, Math.max(0, now - state.lastReview) / DAY_MS, state.stability)
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
