import type * as Y from 'yjs'
import { createScheduler, type Scheduler } from '../srs/fsrs'
import {
  formatSteps,
  parseSteps,
  type QueueLimits,
  queueLimitsOf,
  REVIEW_DEFAULTS,
  REVIEW_SETTING_KEYS,
  type ReviewSettingKey,
  type ReviewSettings,
  sameSetting,
  srsParamsOf,
  validReviewSetting,
} from '../srs/settings'

export class ReviewSettingsError extends RangeError {
  constructor(m: string) {
    super(m)
    this.name = 'ReviewSettingsError'
  }
}

/** Where a setting is kept in the prefs map: the two older ones under their own names, the others as `review.<name>`. */
export function reviewKey(k: ReviewSettingKey): string {
  return k === 'dailyNewCards' || k === 'desiredRetention' ? k : `review.${k}`
}

const isSteps = (k: ReviewSettingKey) => k === 'learningSteps' || k === 'relearningSteps'

/** A stored value as the setting takes it (steps are kept as written, `1m 10m`); undefined when it is not one. */
function fromStored(k: ReviewSettingKey, v: unknown): unknown {
  if (v === undefined) return undefined
  if (isSteps(k)) return typeof v === 'string' ? (parseSteps(v) ?? undefined) : undefined
  return validReviewSetting(k, v) ? v : undefined
}

/**
 * The review settings over the synced prefs map, one key per setting, so two devices changing two settings both
 * keep their change. Read with validation: a value missing, invalid, or written by a version this one does not
 * understand reads as the default. Nothing is written until the student changes a setting, and a setting put back
 * to its default gives its key up: an older version, which knows none of the newer keys, then schedules alike.
 */
export class ReviewSettingsStore {
  constructor(
    private readonly doc: Y.Doc,
    private readonly prefs: Y.Map<unknown>,
  ) {}

  /** Every setting: the stored value where it is valid, the default otherwise. */
  get(): ReviewSettings {
    const out: ReviewSettings = { ...REVIEW_DEFAULTS }
    const target = out as unknown as Record<string, unknown>
    for (const k of REVIEW_SETTING_KEYS) {
      const v = fromStored(k, this.prefs.get(reviewKey(k)))
      if (v !== undefined) target[k] = v
    }
    return out
  }

  /** Writes the settings given (an explicit change only); one equal to its default, or `undefined`, is removed. */
  set(patch: Partial<ReviewSettings>): void {
    const entries = Object.entries(patch) as [ReviewSettingKey, unknown][]
    for (const [k, v] of entries) {
      if (!REVIEW_SETTING_KEYS.includes(k)) throw new ReviewSettingsError(`unknown setting ${String(k)}`)
      if (v !== undefined && !validReviewSetting(k, v))
        throw new ReviewSettingsError(`invalid ${k}: ${JSON.stringify(v)}`)
    }
    this.doc.transact(() => {
      for (const [k, v] of entries) {
        const key = reviewKey(k)
        if (v === undefined || v === null || sameSetting(k, v, REVIEW_DEFAULTS[k])) {
          if (this.prefs.has(key)) this.prefs.delete(key)
        } else {
          const stored = isSteps(k) ? formatSteps(v as ReviewSettings['learningSteps']) : v
          if (this.prefs.get(key) !== stored) this.prefs.set(key, stored)
        }
      }
    })
  }

  /** Back to the recommended settings: every key of the review settings removed. */
  reset(): void {
    this.doc.transact(() => {
      for (const k of REVIEW_SETTING_KEYS) if (this.prefs.has(reviewKey(k))) this.prefs.delete(reviewKey(k))
    })
  }
}

/**
 * The scheduler of the workspace's settings, shared by every screen: with the recommended steps, maximum and
 * variation, the very one `createScheduler({ desiredRetention })` gives.
 */
export function schedulerOf(ws: { reviewSettings: ReviewSettingsStore }): Scheduler {
  return createScheduler(srsParamsOf(ws.reviewSettings.get()))
}

/** What the day's queue takes from the workspace's settings (see `queueLimitsOf`). */
export function queueLimitsFor(ws: { reviewSettings: ReviewSettingsStore }): QueueLimits {
  return queueLimitsOf(ws.reviewSettings.get())
}
