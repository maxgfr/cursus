import type { StepUnit } from 'ts-fsrs'
import type { Rating } from '../contracts/workspace'
import { type CardState, createEngine, DAY_MS, DEFAULT_PARAMS, newCardState, previewWith, type SrsParams } from './fsrs'

/**
 * How reviews are scheduled and queued, as Anki's deck options set them (FSRS): the daily limits, the memory
 * target, the learning steps, how new cards come, and what a card forgotten too often does. The defaults are the
 * recommended ones, the behaviour of a library nobody changed: no setting is ever written until the student
 * changes it. Pure: the model layer stores them, the queue and the scheduler read them.
 */

/** The order new cards come in: as they were added, or shuffled once (the same order from day to day). */
export type NewOrder = 'created' | 'random'
/** Where the day's new cards go among its reviews. */
export type NewMix = 'after' | 'mixed' | 'before'
/** What a card forgotten too often (a leech) does: flagged in review, or also suspended. */
export type LeechAction = 'flag' | 'suspend'

export interface ReviewSettings {
  /** New cards introduced per study day, every course included. */
  dailyNewCards: number
  /** Reviews per study day at most, new cards included; null: no limit. */
  maxReviewsPerDay: number | null
  /** The chance of recalling a card when it comes back (FSRS « desired retention »). */
  desiredRetention: number
  /** Delays between the first answers of a new card, before FSRS takes over. */
  learningSteps: readonly StepUnit[]
  /** Delays between the answers of a forgotten card, before it is a review again. */
  relearningSteps: readonly StepUnit[]
  /** The longest a card waits, in days. */
  maximumInterval: number
  /** A little variation in the intervals, so cards learned together do not keep coming back together. */
  enableFuzz: boolean
  newOrder: NewOrder
  newMix: NewMix
  /** Lapses that make a card a leech. */
  leechThreshold: number
  leechAction: LeechAction
}

export type ReviewSettingKey = keyof ReviewSettings

export const REVIEW_DEFAULTS: Readonly<ReviewSettings> = Object.freeze({
  dailyNewCards: 20,
  maxReviewsPerDay: null,
  desiredRetention: DEFAULT_PARAMS.desiredRetention,
  learningSteps: DEFAULT_PARAMS.learningSteps,
  relearningSteps: DEFAULT_PARAMS.relearningSteps,
  maximumInterval: DEFAULT_PARAMS.maximumInterval,
  enableFuzz: DEFAULT_PARAMS.enableFuzz,
  newOrder: 'created',
  newMix: 'after',
  leechThreshold: 8,
  leechAction: 'flag',
})

export const REVIEW_SETTING_KEYS: readonly ReviewSettingKey[] = Object.keys(REVIEW_DEFAULTS) as ReviewSettingKey[]

/** The range each number may take. */
export const REVIEW_RANGES = {
  dailyNewCards: { min: 0, max: 9999 },
  maxReviewsPerDay: { min: 1, max: 9999 },
  desiredRetention: { min: 0.7, max: 0.97 },
  maximumInterval: { min: 1, max: 36500 },
  leechThreshold: { min: 1, max: 99 },
} as const

/** Steps at most, and how long each may be (in minutes): from a minute to a day. */
export const STEPS_MAX = 10
const STEP_MINUTES = { min: 1, max: 1440 }
const STEP = /^(\d+)([mhd])$/
const UNIT_MINUTES = { m: 1, h: 60, d: 1440 } as const

const NEW_ORDERS: readonly NewOrder[] = ['created', 'random']
const NEW_MIXES: readonly NewMix[] = ['after', 'mixed', 'before']
const LEECH_ACTIONS: readonly LeechAction[] = ['flag', 'suspend']

const inRange = (v: unknown, r: { min: number; max: number }, integer: boolean): v is number =>
  typeof v === 'number' && Number.isFinite(v) && (!integer || Number.isInteger(v)) && v >= r.min && v <= r.max

/**
 * Steps as the student writes them, `1m 10m` (minutes, hours or days; spaces or commas between): null when one is
 * not a step, is shorter than a minute or longer than a day, or when there are more than `STEPS_MAX`. Nothing
 * written: no steps (FSRS schedules from the first answer).
 */
export function parseSteps(text: string): StepUnit[] | null {
  const parts = text
    .trim()
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((p) => p !== '')
  if (parts.length > STEPS_MAX) return null
  const out: StepUnit[] = []
  for (const p of parts) {
    const m = STEP.exec(p)
    if (!m) return null
    const n = Number(m[1])
    const unit = m[2] as keyof typeof UNIT_MINUTES
    const minutes = n * UNIT_MINUTES[unit]
    if (minutes < STEP_MINUTES.min || minutes > STEP_MINUTES.max) return null
    out.push(`${n}${unit}`)
  }
  return out
}

/** Steps as they are written and stored: `1m 10m`. */
export function formatSteps(steps: readonly StepUnit[]): string {
  return steps.join(' ')
}

const validSteps = (v: unknown): boolean =>
  Array.isArray(v) && v.every((s) => typeof s === 'string') && parseSteps(v.join(' '))?.join(' ') === v.join(' ')

/** Whether a value is one the setting can take (steps as a list, as `parseSteps` gives them). */
export function validReviewSetting(k: ReviewSettingKey, v: unknown): boolean {
  switch (k) {
    case 'dailyNewCards':
      return inRange(v, REVIEW_RANGES.dailyNewCards, true)
    case 'maxReviewsPerDay':
      return v === null || inRange(v, REVIEW_RANGES.maxReviewsPerDay, true)
    case 'desiredRetention':
      return inRange(v, REVIEW_RANGES.desiredRetention, false)
    case 'learningSteps':
    case 'relearningSteps':
      return validSteps(v)
    case 'maximumInterval':
      return inRange(v, REVIEW_RANGES.maximumInterval, true)
    case 'enableFuzz':
      return typeof v === 'boolean'
    case 'newOrder':
      return NEW_ORDERS.includes(v as NewOrder)
    case 'newMix':
      return NEW_MIXES.includes(v as NewMix)
    case 'leechThreshold':
      return inRange(v, REVIEW_RANGES.leechThreshold, true)
    case 'leechAction':
      return LEECH_ACTIONS.includes(v as LeechAction)
  }
}

/** Whether two values of a setting are the same (steps compared as written). */
export function sameSetting(k: ReviewSettingKey, a: unknown, b: unknown): boolean {
  if (k === 'learningSteps' || k === 'relearningSteps') {
    return Array.isArray(a) && Array.isArray(b) && a.join(' ') === b.join(' ')
  }
  return a === b
}

/** The scheduler's parameters these settings make. */
export function srsParamsOf(
  s: Pick<ReviewSettings, 'desiredRetention' | 'learningSteps' | 'relearningSteps' | 'maximumInterval' | 'enableFuzz'>,
): SrsParams {
  return {
    desiredRetention: s.desiredRetention,
    learningSteps: [...s.learningSteps],
    relearningSteps: [...s.relearningSteps],
    maximumInterval: s.maximumInterval,
    enableFuzz: s.enableFuzz,
  }
}

/** What the day's queue takes from the settings: only what differs from the default order is given. */
export interface QueueLimits {
  newPerDay: number
  maxReviews?: number
  newOrder?: NewOrder
  newMix?: NewMix
}

export function queueLimitsOf(
  s: Pick<ReviewSettings, 'dailyNewCards' | 'maxReviewsPerDay' | 'newOrder' | 'newMix'>,
): QueueLimits {
  const out: QueueLimits = { newPerDay: s.dailyNewCards }
  if (s.maxReviewsPerDay !== null) out.maxReviews = s.maxReviewsPerDay
  if (s.newOrder !== 'created') out.newOrder = s.newOrder
  if (s.newMix !== 'after') out.newMix = s.newMix
  return out
}

/** A card met for the first time. */
const SAMPLE_NEW = 'sample:new'
/**
 * A card reviewed three days ago, due today, of middling difficulty: with the recommended settings its buttons read
 * « 10 min / 7 d / 9 d / 13 d », as on a typical card in Anki.
 */
function sampleReview(now: number): CardState {
  return {
    ...newCardState('sample:review'),
    phase: 'review',
    due: now,
    stability: 4,
    difficulty: 7.5,
    reps: 3,
    lastReview: now - 3 * DAY_MS,
  }
}

/** What each button would do: the wait it gives, in ms. */
export type ButtonWaits = Record<Rating, number>

/**
 * The waits each button gives with these parameters, on a new card and on a card due for review, to show while
 * the settings are changed. On an engine of its own (the shared schedulers are kept for good), without the
 * variation, so the sample shows the typical wait.
 */
export function previewSamples(params: SrsParams, now: number): { fresh: ButtonWaits; review: ButtonWaits } {
  const engine = createEngine({ ...params, enableFuzz: false })
  const waits = (state: CardState): ButtonWaits => {
    const due = previewWith(engine, state, now)
    return { 1: due[1] - now, 2: due[2] - now, 3: due[3] - now, 4: due[4] - now }
  }
  return { fresh: waits(newCardState(SAMPLE_NEW)), review: waits(sampleReview(now)) }
}

/** What sets a button's wait: a learning step, a relearning step, or FSRS (the retention, within the maximum). */
export type WaitSource = 'learningSteps' | 'relearningSteps' | 'retention'

/**
 * What sets each button's wait on the sample cards of `previewSamples`, as ts-fsrs schedules them. A new card:
 * Again waits the first learning step, Hard between the first two (half as long again with one step), Good the
 * second step when there is one; FSRS gives the rest, Easy always. A card due for review: Again waits the first
 * relearning step when there is one; FSRS gives the rest.
 */
export function previewSources(s: Pick<ReviewSettings, 'learningSteps' | 'relearningSteps'>): {
  fresh: Record<Rating, WaitSource>
  review: Record<Rating, WaitSource>
} {
  const learning = s.learningSteps.length
  const step = (atLeast: number): WaitSource => (learning >= atLeast ? 'learningSteps' : 'retention')
  return {
    fresh: { 1: step(1), 2: step(1), 3: step(2), 4: 'retention' },
    review: {
      1: s.relearningSteps.length > 0 ? 'relearningSteps' : 'retention',
      2: 'retention',
      3: 'retention',
      4: 'retention',
    },
  }
}
