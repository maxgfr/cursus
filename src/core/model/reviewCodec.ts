import type { Id, Rating, Review } from '../contracts/workspace'

type GradedReview = Exclude<Review, { voids: Id }>

/**
 * The compact form of a review-log event: one JSON tuple per event, without repeated keys, stored as a string.
 * Yjs decodes a string far faster than an object with six keys, and the strings are only parsed, by
 * `JSON.parse`, when the reviews are first read.
 *
 *   review  [1, id, cardId, rating, at, ms, dev]  then its session id (`0` for none) when it has one or is
 *           practice, then `1` when it is practice
 *   void    [2, id, voidedId]
 *
 * The leading tag names the format: a tag this version does not know (a later format) is an error, never a
 * silently skipped event (the log quarantines it: kept in the doc, left out of every read, reported).
 */
export const REVIEW_TAG = 1
export const VOID_TAG = 2

export type ReviewDecodeErrorKind = 'version' | 'malformed'

/**
 * An event this version cannot read. Never silently skipped: `ReviewLog` quarantines it (it stays in the doc,
 * is left out of the schedule and the statistics, and is reported through `quarantined()`).
 */
export class ReviewDecodeError extends Error {
  constructor(
    readonly kind: ReviewDecodeErrorKind,
    /** Position of the event in the compact log. */
    readonly index: number,
    m: string,
  ) {
    super(`review log event ${index}: ${m}`)
    this.name = 'ReviewDecodeError'
  }
}

/** A review or void this version refuses to write: nothing of the batch is written. */
export class InvalidReviewError extends Error {
  constructor(
    /** Position of the event in the batch. */
    readonly index: number,
    readonly reason: string,
  ) {
    super(`invalid review event ${index}: ${reason}`)
    this.name = 'InvalidReviewError'
  }
}

const isId = (v: unknown): v is string => typeof v === 'string' && v !== ''

/**
 * Why `e` is not an event this version can write and read back exactly (null when it is): the same rules as
 * `decodeEvent`, applied to the object form (the write boundary, and events of the legacy array).
 */
export function reviewProblem(e: unknown): string | null {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return 'not an event'
  const r = e as Record<string, unknown>
  if (!isId(r.id)) return 'id is not a non-empty string'
  if ('voids' in r) {
    if (!isId(r.voids)) return 'voided id is not a non-empty string'
    return null
  }
  if (!isId(r.cardId)) return 'card id is not a non-empty string'
  if (!isRating(r.rating)) return `rating ${String(r.rating)} is not an integer from 1 to 4`
  if (!isNumber(r.at)) return `time ${String(r.at)} is not a finite number`
  if (!isNumber(r.ms)) return `answer time ${String(r.ms)} is not a finite number`
  if (typeof r.dev !== 'string') return 'device is not a string'
  if (r.sid !== undefined && !isId(r.sid)) return 'session id is not a non-empty string'
  if (r.p !== undefined && r.p !== true) return 'practice flag is not true'
  return null
}

export function encodeEvent(e: Review): string {
  if ('voids' in e) return JSON.stringify([VOID_TAG, e.id, e.voids])
  const t: unknown[] = [REVIEW_TAG, e.id, e.cardId, e.rating, e.at, e.ms, e.dev]
  if (e.sid !== undefined || e.p === true) t.push(e.sid ?? 0)
  if (e.p === true) t.push(1)
  return JSON.stringify(t)
}

const isRating = (v: unknown): v is Rating => v === 1 || v === 2 || v === 3 || v === 4
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Decodes one event; throws `ReviewDecodeError` on anything it cannot read exactly. */
export function decodeEvent(s: unknown, index: number): Review {
  if (typeof s !== 'string') throw new ReviewDecodeError('malformed', index, `not a string (${typeof s})`)
  let t: unknown
  try {
    t = JSON.parse(s)
  } catch (e) {
    throw new ReviewDecodeError('malformed', index, `not JSON (${String(e)})`)
  }
  if (!Array.isArray(t)) throw new ReviewDecodeError('malformed', index, 'not a tuple')
  const tag: unknown = t[0]
  if (typeof tag !== 'number') throw new ReviewDecodeError('malformed', index, 'no tag')
  if (tag === VOID_TAG) {
    const id: unknown = t[1]
    const voids: unknown = t[2]
    if (t.length !== 3 || typeof id !== 'string' || typeof voids !== 'string')
      throw new ReviewDecodeError('malformed', index, 'a void is [2, id, voidedId]')
    return { id, voids }
  }
  if (tag !== REVIEW_TAG) throw new ReviewDecodeError('version', index, `unknown event tag ${tag}`)
  // Indexed reads, not destructuring: this runs for every review of the library at launch.
  const id: unknown = t[1]
  const cardId: unknown = t[2]
  const rating: unknown = t[3]
  const at: unknown = t[4]
  const ms: unknown = t[5]
  const dev: unknown = t[6]
  const sid: unknown = t[7]
  const p: unknown = t[8]
  if (
    t.length < 7 ||
    t.length > 9 ||
    typeof id !== 'string' ||
    typeof cardId !== 'string' ||
    !isRating(rating) ||
    !isNumber(at) ||
    !isNumber(ms) ||
    typeof dev !== 'string' ||
    (t.length >= 8 && sid !== 0 && typeof sid !== 'string') ||
    (t.length === 9 && p !== 1)
  )
    throw new ReviewDecodeError('malformed', index, 'a review is [1, id, cardId, rating, at, ms, dev, sid?, p?]')
  // Same keys, in the same order, as a review recorded the legacy way.
  const e: GradedReview = { id, cardId, rating, at, ms, dev }
  if (typeof sid === 'string') e.sid = sid
  if (p === 1) e.p = true
  return e
}
