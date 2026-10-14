import type * as Y from 'yjs'
import type { Clock, Rng } from '../contracts/ports'
import type { Id, NewReview, Review } from '../contracts/workspace'
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

/** Replay order is (at, id); negative gaps between consecutive reviews are clamped to 0. */
export function replay(events: readonly ReviewEvent[]): { event: ReviewEvent; gapMs: number }[] {
  const sorted = [...events].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return sorted.map((event, i) => {
    const prev = sorted[i - 1]
    return { event, gapMs: prev ? Math.max(0, event.at - prev.at) : 0 }
  })
}

export class ReviewLog {
  private readonly arr: Y.Array<Review>
  private cache: Map<Id, readonly Review[]> | null = null

  constructor(
    doc: Y.Doc,
    private readonly rng: Rng,
    private readonly dev: string,
  ) {
    this.arr = doc.getArray<Review>(ROOT.reviews)
    this.arr.observe(() => {
      this.cache = null
    })
  }

  get yArray(): Y.Array<Review> {
    return this.arr
  }

  private event(r: NewReview): ReviewEvent {
    return { id: this.rng.id(), cardId: r.cardId, rating: r.rating, at: r.at, ms: Math.max(0, r.ms), dev: this.dev }
  }

  record(r: NewReview): Id {
    const e = this.event(r)
    this.arr.push([e])
    this.cache = null
    return e.id
  }

  /**
   * Records many reviews with ONE push: same events, ids and order as calling `record` for each, but linear.
   * Separate pushes inside one transaction are quadratic in Yjs (pending items only merge on commit).
   */
  recordMany(rs: readonly NewReview[]): Id[] {
    if (rs.length === 0) return []
    const events = rs.map((r) => this.event(r))
    this.arr.push(events)
    this.cache = null
    return events.map((e) => e.id)
  }

  void(id: Id): void {
    this.arr.push([{ id: this.rng.id(), voids: id }])
    this.cache = null
  }

  /** Non-voided reviews of a card in replay order (memoized). */
  forCard(cardId: Id): readonly Review[] {
    if (!this.cache) {
      const by = new Map<Id, ReviewEvent[]>()
      for (const e of effective<ReviewEvent>(this.arr.toArray())) {
        const list = by.get(e.cardId) ?? []
        list.push(e)
        by.set(e.cardId, list)
      }
      const cache = new Map<Id, readonly Review[]>()
      for (const [k, v] of by)
        cache.set(
          k,
          replay(v).map((x) => x.event),
        )
      this.cache = cache
    }
    return this.cache.get(cardId) ?? EMPTY
  }
}

const EMPTY: readonly Review[] = Object.freeze([])

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

  record(u: { model: string; inTok: number; outTok: number }): Id {
    const id = this.rng.id()
    this.arr.push([{ id, at: this.clock.now(), model: u.model, inTok: u.inTok, outTok: u.outTok, dev: this.dev }])
    return id
  }

  void(id: Id): void {
    this.arr.push([{ id: this.rng.id(), voids: id }])
  }

  list(): Exclude<AiUsageEvent, { voids: Id }>[] {
    return effective<Exclude<AiUsageEvent, { voids: Id }>>(this.arr.toArray())
  }
}
