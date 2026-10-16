import type * as Y from 'yjs'
import type { Id, SessionScope } from '../contracts/workspace'
import { createScheduler, type Scheduler } from '../srs/fsrs'
import type { CourseLimits } from '../srs/queue'
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
import type { CourseFields, CourseRecord } from './schema'

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

type CourseReviewField = Extract<keyof CourseFields, `review${string}`>

/** Where a course keeps its own value of a setting: a scalar field of the course. */
export const COURSE_REVIEW_FIELDS: Readonly<Record<ReviewSettingKey, CourseReviewField>> = {
  dailyNewCards: 'reviewNewPerDay',
  maxReviewsPerDay: 'reviewMaxPerDay',
  desiredRetention: 'reviewRetention',
  learningSteps: 'reviewLearningSteps',
  relearningSteps: 'reviewRelearningSteps',
  maximumInterval: 'reviewMaxInterval',
  enableFuzz: 'reviewFuzz',
  newOrder: 'reviewNewOrder',
  newMix: 'reviewNewMix',
  leechThreshold: 'reviewLeechThreshold',
  leechAction: 'reviewLeechAction',
}

const isSteps = (k: ReviewSettingKey) => k === 'learningSteps' || k === 'relearningSteps'

/** A stored value as the setting takes it (steps are kept as written, `1m 10m`); undefined when it is not one. */
function fromStored(k: ReviewSettingKey, v: unknown): unknown {
  if (v === undefined) return undefined
  if (isSteps(k)) return typeof v === 'string' ? (parseSteps(v) ?? undefined) : undefined
  return validReviewSetting(k, v) ? v : undefined
}

/** A setting as it is stored: steps as written. */
const toStored = (k: ReviewSettingKey, v: unknown): unknown =>
  isSteps(k) ? formatSteps(v as ReviewSettings['learningSteps']) : v

function check(patch: Partial<ReviewSettings>): [ReviewSettingKey, unknown][] {
  const entries = Object.entries(patch) as [ReviewSettingKey, unknown][]
  for (const [k, v] of entries) {
    if (!REVIEW_SETTING_KEYS.includes(k)) throw new ReviewSettingsError(`unknown setting ${String(k)}`)
    if (v !== undefined && !validReviewSetting(k, v))
      throw new ReviewSettingsError(`invalid ${k}: ${JSON.stringify(v)}`)
  }
  return entries
}

/** The settings a course gives itself: its valid fields only (a value a newer version wrote, unread, is left out). */
export function courseOverrides(course: Partial<CourseFields> | undefined): Partial<ReviewSettings> {
  const out: Partial<ReviewSettings> = {}
  if (!course) return out
  const target = out as Record<string, unknown>
  for (const k of REVIEW_SETTING_KEYS) {
    const v = fromStored(k, course[COURSE_REVIEW_FIELDS[k]])
    if (v !== undefined) target[k] = v
  }
  return out
}

/** What the store needs of the courses (every write still goes through their repo). */
export interface ReviewCourses {
  get(id: Id): CourseRecord | undefined
  update(id: Id, patch: Partial<CourseFields>): void
}

/**
 * The review settings over the synced prefs map, one key per setting, so two devices changing two settings both
 * keep their change; and a course's own ones, a scalar field of the course each, over them (as an Anki deck's
 * options over its parent's). Read with validation: a value missing, invalid, or written by a version this one does
 * not understand reads as the default (or as all cards' for a course). Nothing is written until the student changes
 * a setting, and a setting put back to its default (or, for a course, to all cards' value) gives its key up: an
 * older version, which knows none of the newer keys, then schedules alike.
 */
export class ReviewSettingsStore {
  constructor(
    private readonly doc: Y.Doc,
    private readonly prefs: Y.Map<unknown>,
    private readonly courses?: ReviewCourses,
  ) {}

  /** Every setting of all cards: the stored value where it is valid, the default otherwise. */
  get(): ReviewSettings {
    const out: ReviewSettings = { ...REVIEW_DEFAULTS }
    const target = out as unknown as Record<string, unknown>
    for (const k of REVIEW_SETTING_KEYS) {
      const v = fromStored(k, this.prefs.get(reviewKey(k)))
      if (v !== undefined) target[k] = v
    }
    return out
  }

  /** The settings a course studies with: its own where it has some, all cards' elsewhere. No course: all cards'. */
  forCourse(courseId: Id | undefined): ReviewSettings {
    const all = this.get()
    if (courseId === undefined || !this.courses) return all
    return { ...all, ...courseOverrides(this.courses.get(courseId)) }
  }

  /** The settings a course gives itself. */
  overrides(courseId: Id): Partial<ReviewSettings> {
    return courseOverrides(this.courses?.get(courseId))
  }

  /** Writes the settings of all cards given (an explicit change only); one equal to its default, or `undefined`, is removed. */
  set(patch: Partial<ReviewSettings>): void {
    const entries = check(patch)
    this.doc.transact(() => {
      for (const [k, v] of entries) {
        const key = reviewKey(k)
        if (v === undefined || v === null || sameSetting(k, v, REVIEW_DEFAULTS[k])) {
          if (this.prefs.has(key)) this.prefs.delete(key)
        } else {
          const stored = toStored(k, v)
          if (this.prefs.get(key) !== stored) this.prefs.set(key, stored)
        }
      }
    })
  }

  /**
   * Writes a course's own settings: one equal to all cards' value, or `undefined` (`null`: no review limit of its
   * own), is given up, so the course follows all cards for it again.
   */
  setForCourse(courseId: Id, patch: Partial<ReviewSettings>): void {
    const courses = this.courses
    if (!courses) throw new ReviewSettingsError('no courses')
    const entries = check(patch)
    const all = this.get()
    const fields: Record<string, unknown> = {}
    for (const [k, v] of entries) {
      // No review limit of its own (`null`): the course has all cards' limit, within which its own would count.
      const same = v === undefined || v === null || sameSetting(k, v, all[k])
      fields[COURSE_REVIEW_FIELDS[k]] = same ? undefined : toStored(k, v)
    }
    courses.update(courseId, fields as Partial<CourseFields>)
  }

  /** The course follows all cards again: every setting of its own given up. */
  clearCourse(courseId: Id): void {
    const fields: Record<string, undefined> = {}
    for (const k of REVIEW_SETTING_KEYS) fields[COURSE_REVIEW_FIELDS[k]] = undefined
    this.courses?.update(courseId, fields as Partial<CourseFields>)
  }

  /** Back to the recommended settings for all cards: every key of the review settings removed. */
  reset(): void {
    this.doc.transact(() => {
      for (const k of REVIEW_SETTING_KEYS) if (this.prefs.has(reviewKey(k))) this.prefs.delete(reviewKey(k))
    })
  }
}

type WithSettings = { reviewSettings: ReviewSettingsStore }

/**
 * The scheduler a course's cards are scheduled with (all cards' without a course), shared by every screen:
 * with the recommended steps, maximum and variation, the very one `createScheduler({ desiredRetention })` gives.
 */
export function schedulerOf(ws: WithSettings, courseId?: Id): Scheduler {
  return createScheduler(srsParamsOf(ws.reviewSettings.forCourse(courseId)))
}

/** Each course's scheduler, read once per course for one computation over many cards. */
export function schedulersOf(ws: WithSettings): (courseId: Id) => Scheduler {
  const by = new Map<Id, Scheduler>()
  return (courseId) => {
    let s = by.get(courseId)
    if (!s) {
      s = schedulerOf(ws, courseId)
      by.set(courseId, s)
    }
    return s
  }
}

/**
 * What the day's queue takes from the settings: all cards' limits, the order of the place studied (a course's own
 * when the queue is that course's), and the limits of each course that has its own (`courses`: the courses whose
 * cards are queued). The cards then need their `courseId`.
 */
export function queueLimitsFor(
  ws: WithSettings,
  scope?: SessionScope,
  courses: Iterable<Id> = [],
): QueueLimits & { courseLimits?: ReadonlyMap<Id, CourseLimits> } {
  const all = ws.reviewSettings.get()
  const place = scope?.courseId === undefined ? all : ws.reviewSettings.forCourse(scope.courseId)
  const out: QueueLimits & { courseLimits?: ReadonlyMap<Id, CourseLimits> } = {
    ...queueLimitsOf({ ...place, dailyNewCards: all.dailyNewCards, maxReviewsPerDay: all.maxReviewsPerDay }),
  }
  const own = new Map<Id, CourseLimits>()
  for (const courseId of new Set(courses)) {
    const o = ws.reviewSettings.overrides(courseId)
    if (o.dailyNewCards === undefined && o.maxReviewsPerDay === undefined) continue
    const s = { ...all, ...o }
    own.set(courseId, {
      newPerDay: s.dailyNewCards,
      ...(s.maxReviewsPerDay === null ? {} : { maxReviews: s.maxReviewsPerDay }),
    })
  }
  if (own.size > 0) out.courseLimits = own
  return out
}
