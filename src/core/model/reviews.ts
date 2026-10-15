import type * as Y from 'yjs'
import type { Clock, Rng } from '../contracts/ports'
import type { Id, NewReview, Review } from '../contracts/workspace'
import { decodeEvent, encodeEvent, InvalidReviewError, ReviewDecodeError, reviewProblem } from './reviewCodec'
import { type AiUsageEvent, ROOT } from './schema'

export type ReviewEvent = NewReview & { id: Id; dev: string }

function isVoid<E extends { id: Id }>(e: E | { id: Id; voids: Id }): e is { id: Id; voids: Id } {
  return 'voids' in e
}

/** Effective events: void events removed along with what they void. */
export function effective<E extends { id: Id }>(events: readonly (E | { id: Id; voids: Id })[]): E[] {
  const voided = new Set<Id>()
  for (const e of events) if (isVoid(e)) voided.add(e.voids)
  const out: E[] = []
  for (const e of events) if (!isVoid(e) && !voided.has(e.id)) out.push(e)
  return out
}

/** Replay order: (at, id). */
const inReplayOrder = (a: ReviewEvent, b: ReviewEvent): number =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Replay order is (at, id); negative gaps between consecutive reviews are clamped to 0. */
export function replay(events: readonly ReviewEvent[]): { event: ReviewEvent; gapMs: number }[] {
  const sorted = [...events].sort(inReplayOrder)
  return sorted.map((event, i) => {
    const prev = sorted[i - 1]
    return { event, gapMs: prev ? Math.max(0, event.at - prev.at) : 0 }
  })
}

/**
 * An event of the synced log this version cannot read (garbled, or written by a later format). It stays in the
 * doc, never rewritten nor removed (a later version may read it), and is left out of every read: one bad value
 * must not stop the schedule, the statistics or the review screen on every device. `quarantined()` reports it.
 */
export interface QuarantinedEvent {
  /** Which array holds it: the legacy one (objects) or the compact one (strings). */
  log: 'legacy' | 'compact'
  /** Its position in that array. */
  index: number
  /** `version`: a later format; `malformed`: garbled. */
  kind: 'version' | 'malformed'
  reason: string
}

/** Decodes compact events from `from` on; what does not decode is quarantined, never thrown nor dropped silently. */
function decodeCompact(raw: readonly unknown[], from: number, into: Review[], bad: QuarantinedEvent[]): void {
  for (let i = 0; i < raw.length; i++) {
    try {
      into.push(decodeEvent(raw[i], from + i))
    } catch (e) {
      if (!(e instanceof ReviewDecodeError)) throw e
      bad.push({ log: 'compact', index: e.index, kind: e.kind, reason: e.message })
    }
  }
}

/**
 * A legacy event as this version reads it: as written, or, when only its answer time is not a number (an earlier
 * build imported an Anki row whose time was not one), with no time (0), as an import does now. The answer time
 * only feeds the statistics; the review itself moved the schedule and stays in it.
 */
function legacyEvent(e: unknown): { event: unknown; why: string | null } {
  const why = reviewProblem(e)
  if (why === null || typeof e !== 'object' || e === null || !('ms' in e) || Number.isFinite(e.ms))
    return { event: e, why }
  const timeless = { ...e, ms: 0 }
  return reviewProblem(timeless) === null ? { event: timeless, why: null } : { event: e, why }
}

/** The legacy array's events, those this version cannot read set aside. */
function checkLegacy(raw: readonly unknown[]): { events: Review[]; bad: QuarantinedEvent[] } {
  const bad: QuarantinedEvent[] = []
  let events: Review[] | null = null
  for (let i = 0; i < raw.length; i++) {
    const { event, why } = legacyEvent(raw[i])
    if (why === null && event === raw[i]) {
      events?.push(event as Review)
      continue
    }
    // Copied only once an event is set aside or read differently: the usual log is read as is.
    events ??= raw.slice(0, i) as Review[]
    if (why === null) events.push(event as Review)
    else bad.push({ log: 'legacy', index: i, kind: 'malformed', reason: `legacy review event ${i}: ${why}` })
  }
  return { events: events ?? (raw as Review[]), bad }
}

/**
 * Every event of a doc's review log (legacy, then compact), voids included, read once without a `ReviewLog`;
 * events this version cannot read are left out (see `QuarantinedEvent`).
 */
export function reviewEvents(doc: Y.Doc): Review[] {
  const legacy = checkLegacy(doc.getArray<unknown>(ROOT.reviews).toArray())
  const compact: Review[] = []
  decodeCompact(doc.getArray<unknown>(ROOT.reviewLog).toArray(), 0, compact, [])
  return legacy.events.concat(compact)
}

/** The whole review log as one read-only array: the legacy array's events, then the compact ones, voids included. */
export interface ReviewLogView {
  /** Number of events (decodes the compact log). */
  readonly length: number
  toArray(): Review[]
  toJSON(): Review[]
}

/**
 * The review log: append-only, merged across devices. Events are written to the compact log (one string per
 * event, see reviewCodec.ts); those written by earlier versions stay in the legacy array, read alongside and
 * never rewritten. Voids apply across both, by id. An earlier version had no practice mode: a review it wrote
 * (no `p`) is a counted review and moves the schedule; a void of a practice review takes it out of the
 * statistics and leaves the schedule as it was, since practice reviews never entered it.
 *
 * Writes are validated first (`InvalidReviewError`, nothing of the batch written). An event already in the doc
 * that this version cannot read is quarantined, never thrown on every read nor deleted: see `QuarantinedEvent`.
 */
export class ReviewLog {
  private readonly legacy: Y.Array<Review>
  private readonly compact: Y.Array<string>
  /** The good events among the compact log's first `decoded` strings, decoded once. */
  private compactEvents: Review[] = []
  /** The compact strings among the first `decoded` that do not decode. */
  private compactBad: QuarantinedEvent[] = []
  private decoded = 0
  /** The legacy array, checked once per change. */
  private legacyChecked: { events: Review[]; bad: QuarantinedEvent[] } | null = null
  private cache: Map<Id, readonly Review[]> | null = null
  private everything: { all: readonly ReviewEvent[]; bySession: Map<Id, ReviewEvent[]> } | null = null
  private readonly view: ReviewLogView

  constructor(
    doc: Y.Doc,
    private readonly rng: Rng,
    private readonly dev: string,
  ) {
    this.legacy = doc.getArray<Review>(ROOT.reviews)
    this.compact = doc.getArray<string>(ROOT.reviewLog)
    this.legacy.observe(() => {
      this.legacyChecked = null
      this.invalidate()
    })
    this.compact.observe((e) => {
      // Events decoded so far stay valid while every change lands after them (the usual append).
      let at = 0
      for (const d of e.changes.delta) {
        if (d.retain !== undefined) at += d.retain
        else if (d.insert !== undefined && at >= this.decoded) at += d.insert.length
        else {
          this.resetCompact()
          break
        }
      }
      this.invalidate()
    })
    const events = (): Review[] => this.events()
    this.view = {
      get length() {
        return events().length
      },
      toArray: events,
      toJSON: events,
    }
  }

  /** The raw log (legacy events, then the compact ones), voids included. */
  get yArray(): ReviewLogView {
    return this.view
  }

  /** The shared types holding the log, for observers and undo. */
  get yRoots(): readonly [Y.Array<Review>, Y.Array<string>] {
    return [this.legacy, this.compact]
  }

  private invalidate(): void {
    this.cache = null
    this.everything = null
  }

  private resetCompact(): void {
    this.compactEvents = []
    this.compactBad = []
    this.decoded = 0
  }

  private legacyEvents(): { events: Review[]; bad: QuarantinedEvent[] } {
    this.legacyChecked ??= checkLegacy(this.legacy.toArray())
    return this.legacyChecked
  }

  /**
   * Every readable event, legacy first; compact events are decoded once, then only the ones appended since.
   * Those that cannot be read are quarantined (`quarantined()`), never thrown.
   */
  private events(): Review[] {
    const n = this.compact.length
    // Fewer events than decoded: some were undone before the observer could say so.
    if (this.decoded > n) this.resetCompact()
    if (this.decoded < n) {
      const fresh = this.decoded === 0 ? this.compact.toArray() : this.compact.slice(this.decoded)
      decodeCompact(fresh, this.decoded, this.compactEvents, this.compactBad)
      this.decoded = n
    }
    const legacy = this.legacyEvents().events
    return legacy.length === 0 ? this.compactEvents.slice() : legacy.concat(this.compactEvents)
  }

  /** Events of the doc this version cannot read: kept there, left out of every read (legacy first). */
  quarantined(): readonly QuarantinedEvent[] {
    this.events()
    const legacy = this.legacyEvents().bad
    return legacy.length === 0 && this.compactBad.length === 0 ? NONE : [...legacy, ...this.compactBad]
  }

  private event(r: NewReview): ReviewEvent {
    const e: ReviewEvent = {
      id: this.rng.id(),
      cardId: r.cardId,
      rating: r.rating,
      at: r.at,
      ms: Math.max(0, r.ms),
      dev: this.dev,
    }
    // Only set when given: older reviews simply lack them.
    if (r.sid !== undefined) e.sid = r.sid
    if (r.p === true) e.p = true
    return e
  }

  /** Validates the whole batch first: an event that could not be read back exactly is refused, nothing is written. */
  private write(events: readonly Review[]): void {
    for (let i = 0; i < events.length; i++) {
      const why = reviewProblem(events[i])
      if (why !== null) throw new InvalidReviewError(i, why)
    }
    this.compact.push(events.map(encodeEvent))
    this.invalidate()
  }

  record(r: NewReview): Id {
    const e = this.event(r)
    this.write([e])
    return e.id
  }

  /**
   * Records many reviews with ONE push: same events, ids and order as calling `record` for each, but linear.
   * Separate pushes inside one transaction are quadratic in Yjs (pending items only merge on commit).
   */
  recordMany(rs: readonly NewReview[]): Id[] {
    if (rs.length === 0) return []
    const events = rs.map((r) => this.event(r))
    this.write(events)
    return events.map((e) => e.id)
  }

  void(id: Id): void {
    this.write([{ id: this.rng.id(), voids: id }])
  }

  private grouped(): { all: readonly ReviewEvent[]; bySession: Map<Id, ReviewEvent[]> } {
    if (!this.everything) {
      const all = effective<ReviewEvent>(this.events()).sort(inReplayOrder)
      const bySession = new Map<Id, ReviewEvent[]>()
      for (const e of all) {
        if (e.sid === undefined) continue
        const list = bySession.get(e.sid)
        if (list) list.push(e)
        else bySession.set(e.sid, [e])
      }
      this.everything = { all, bySession }
    }
    return this.everything
  }

  /** Every non-voided review (practice included) in replay order (memoized). */
  all(): readonly ReviewEvent[] {
    return this.grouped().all
  }

  /** Non-voided reviews given in a session, in replay order (memoized). */
  forSession(sid: Id): readonly ReviewEvent[] {
    return this.grouped().bySession.get(sid) ?? EMPTY_EVENTS
  }

  /** Non-voided reviews of a card in replay order (memoized). */
  forCard(cardId: Id): readonly Review[] {
    if (!this.cache) {
      const by = new Map<Id, ReviewEvent[]>()
      for (const e of effective<ReviewEvent>(this.events())) {
        const list = by.get(e.cardId)
        if (list) list.push(e)
        else by.set(e.cardId, [e])
      }
      // Each list was built just above: sorted in place, in replay order.
      for (const v of by.values()) v.sort(inReplayOrder)
      this.cache = by
    }
    return this.cache.get(cardId) ?? EMPTY
  }
}

const NONE: readonly QuarantinedEvent[] = Object.freeze([])
const EMPTY: readonly Review[] = Object.freeze([])
const EMPTY_EVENTS: readonly ReviewEvent[] = Object.freeze([])

export class AiUsageLog {
  private readonly arr: Y.Array<AiUsageEvent>

  constructor(
    doc: Y.Doc,
    private readonly rng: Rng,
    private readonly clock: Clock,
    private readonly dev: string,
  ) {
    this.arr = doc.getArray<AiUsageEvent>(ROOT.aiUsage)
  }

  record(u: { model: string; inTok: number; outTok: number; src?: Id }): Id {
    const id = this.rng.id()
    const e: AiUsageEvent = {
      id,
      at: this.clock.now(),
      model: u.model,
      inTok: u.inTok,
      outTok: u.outTok,
      dev: this.dev,
    }
    // Only set when known: older events, and calls not made for a source, simply lack it.
    if (u.src !== undefined) e.src = u.src
    this.arr.push([e])
    return id
  }

  void(id: Id): void {
    this.arr.push([{ id: this.rng.id(), voids: id }])
  }

  list(): Exclude<AiUsageEvent, { voids: Id }>[] {
    return effective<Exclude<AiUsageEvent, { voids: Id }>>(this.arr.toArray())
  }
}
