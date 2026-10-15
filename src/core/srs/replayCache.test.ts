import { describe, expect, test } from 'bun:test'
import type { Rating, Review } from '../contracts/workspace'
import { type CardState, createScheduler, DAY_MS, effectiveReviews, type GradedReview } from './fsrs'
import { buildQueue, inScope, type QueueCard } from './queue'

const T0 = Date.UTC(2026, 0, 5, 9, 0, 0)
const rv = (id: string, cardId: string, rating: Rating, at: number): GradedReview => ({
  id,
  cardId,
  rating,
  at,
  ms: 2000,
  dev: 'd',
})

/** A history long enough to cross every phase: learning, review, lapse, relearning. */
function history(cardId: string, n: number): GradedReview[] {
  const ratings: Rating[] = [3, 3, 3, 1, 3, 4, 2, 3, 3, 1, 1, 3, 4, 3, 2, 3, 3, 3, 4, 3]
  const out: GradedReview[] = []
  let t = T0
  for (let i = 0; i < n; i++) {
    t += (i % 5) * DAY_MS + 10 * 60_000
    out.push(rv(`${cardId}-${String(i).padStart(2, '0')}`, cardId, ratings[i % ratings.length] as Rating, t))
  }
  return out
}

// Every scheduler with the same parameters shares one cache; a maximum interval far beyond
// these histories gives a fresh cache with identical results.
let fresh = 0
const freshScheduler = () => createScheduler({ maximumInterval: 50_000 + fresh++ })

describe('replay cache', () => {
  test('schedulers with the same parameters are shared', () => {
    expect(createScheduler({ desiredRetention: 0.85 })).toBe(createScheduler({ desiredRetention: 0.85 }))
    expect(createScheduler({ desiredRetention: 0.85 })).not.toBe(createScheduler({ desiredRetention: 0.86 }))
  })

  test('appended reviews resume from the cached state and match a full replay', () => {
    const log = history('a', 20)
    const sch = freshScheduler()
    sch.replay('a', log.slice(0, 12))
    const before = sch.replays
    const resumed = sch.replay('a', log)
    expect(sch.replays).toBe(before + 1)
    expect(resumed).toEqual(freshScheduler().replay('a', log))
  })

  test('a merge that changes an earlier review replays from the start', () => {
    const log = history('b', 10)
    const sch = freshScheduler()
    sch.replay('b', log)
    // Same count, same last review, an earlier rating changed.
    const changed = log.map((r, i) => (i === 3 ? { ...r, rating: 4 as Rating } : r))
    expect(sch.replay('b', changed)).toEqual(freshScheduler().replay('b', changed))
    // An earlier review inserted under the same last review.
    const inserted = [...log.slice(0, 2), rv('b-01x', 'b', 2, (log[1] as GradedReview).at + 1), ...log.slice(2)]
    expect(sch.replay('b', inserted)).toEqual(freshScheduler().replay('b', inserted))
    // Fewer reviews (an undo) than cached.
    expect(sch.replay('b', log.slice(0, 4))).toEqual(freshScheduler().replay('b', log.slice(0, 4)))
  })

  test('a different last review with the same hash prefix replays from the start', () => {
    const log = history('c', 6)
    const sch = freshScheduler()
    sch.replay('c', log)
    const renamed = log.map((r, i) => (i === 5 ? { ...r, id: 'c-zz' } : r))
    expect(sch.replay('c', renamed).history.at(-1)?.reviewId).toBe('c-zz')
  })

  test('an earlier review replaced by another with the same time and rating names the new one in the history', () => {
    // A review voided while another device answered the same card at the same instant with the same rating:
    // the schedule is the same, but the history must name the review that is actually there.
    const log = history('g', 6)
    const sch = freshScheduler()
    sch.replay('g', log)
    const swapped = log.map((r, i) => (i === 2 ? { ...r, id: 'g-02x' } : r))
    expect(sch.replay('g', swapped)).toEqual(freshScheduler().replay('g', swapped))
    // The same with reviews appended since: the resumed history names the review that is there too.
    const sch2 = freshScheduler()
    sch2.replay('g', log.slice(0, 4))
    const longer = history('g', 8).map((r, i) => (i === 1 ? { ...r, id: 'g-01x' } : r))
    expect(sch2.replay('g', longer)).toEqual(freshScheduler().replay('g', longer))
  })

  test('a snapshot restored on a new launch gives the same states without replaying', () => {
    const logs = ['d', 'e', 'f'].map((id) => history(id, 15))
    const first = freshScheduler()
    const expected = logs.map((l, i) => first.replay(['d', 'e', 'f'][i] as string, l))
    const snap = structuredClone(first.snapshot())
    expect(snap.ids).toEqual(['d', 'e', 'f'])

    // A new launch: empty cache (another maximum interval, which these histories never reach).
    const next = freshScheduler()
    next.restore({ ...snap, params: next.snapshot().params })
    const states = logs.map((l, i) => next.replay(['d', 'e', 'f'][i] as string, l))
    expect(next.replays).toBe(0)
    expect(states).toEqual(expected)
    // Restored entries resume when reviews were appended since.
    const longer = history('d', 18)
    expect(next.replay('d', longer)).toEqual(freshScheduler().replay('d', longer))
    expect(next.replays).toBe(1)
  })

  test('a snapshot that no longer fits is ignored', () => {
    const log = history('g', 8)
    const src = freshScheduler()
    src.replay('g', log)
    const snap = src.snapshot()
    const target = freshScheduler()
    const params = target.snapshot().params
    // Other parameters, or another version: ignored.
    target.restore(snap)
    target.restore({ ...snap, v: 2 as 1, params })
    target.replay('g', log)
    expect(target.replays).toBe(1)
    // Fewer reviews than the snapshot covered, or a corrupt phase list: replayed.
    const other = freshScheduler()
    const otherParams = other.snapshot().params
    other.restore({ ...snap, params: otherParams })
    other.replay('g', log.slice(0, 5))
    expect(other.replays).toBe(1)
    const third = freshScheduler()
    third.restore({ ...snap, params: third.snapshot().params, phases: ['nl'] })
    expect(third.replay('g', log)).toEqual(freshScheduler().replay('g', log))
    expect(third.replays).toBe(1)
    // A card the snapshot never saw.
    expect(third.replay('h', history('h', 2)).reps).toBe(2)
  })

  test('a scoped queue replays only its cards; the cache and its snapshot then serve the whole queue unchanged', () => {
    const cards: QueueCard[] = [
      { id: 'p1', courseId: 'law', sections: ['contracts'] },
      { id: 'p2', courseId: 'law', sections: ['contracts', 'formation'] },
      { id: 'p3', courseId: 'law', sections: ['torts'] },
      { id: 'p4', courseId: 'bio' },
    ]
    const logs = new Map(cards.map((c, i) => [c.id, history(c.id, 8 + i)]))
    const now = T0 + 60 * DAY_MS
    const scope = { courseId: 'law', sectionId: 'contracts' }
    const replayed = (sch: ReturnType<typeof freshScheduler>, list: readonly QueueCard[]) =>
      new Map<string, CardState>(list.map((c) => [c.id, sch.replay(c.id, logs.get(c.id) ?? [])]))
    const queue = (states: Map<string, CardState>, s?: typeof scope) =>
      buildQueue({ cards, states, now, tzOffsetMin: 0, newPerDay: 0, ...(s ? { scope: s } : {}) })

    const sch = freshScheduler()
    const scoped = queue(
      replayed(
        sch,
        cards.filter((c) => inScope(c, scope)),
      ),
      scope,
    )
    expect(sch.replays).toBe(2)
    const all = queue(replayed(sch, cards))
    expect(sch.replays).toBe(4)
    const truth = queue(replayed(freshScheduler(), cards))
    expect(all).toEqual(truth)
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped).toEqual(truth.filter((q) => q.cardId === 'p1' || q.cardId === 'p2'))

    const next = freshScheduler()
    next.restore({ ...sch.snapshot(), params: next.snapshot().params })
    expect(queue(replayed(next, cards))).toEqual(truth)
    expect(next.replays).toBe(0)
  })

  test('effectiveReviews keeps an ordered log as is', () => {
    const log: Review[] = history('i', 5)
    expect(effectiveReviews(log)).toEqual(log as GradedReview[])
    expect(effectiveReviews(log)).not.toBe(log)
  })

  test('benchmark: 2,000 cards x 20 reviews replay, then a warm pass, within generous bounds', () => {
    const logs = Array.from({ length: 2_000 }, (_, i) => history(`k${i}`, 20))
    const sch = freshScheduler()
    let t = performance.now()
    for (const [i, l] of logs.entries()) sch.replay(`k${i}`, l)
    const cold = performance.now() - t
    const snap = sch.snapshot()
    const next = freshScheduler()
    next.restore({ ...snap, params: next.snapshot().params })
    t = performance.now()
    for (const [i, l] of logs.entries()) next.replay(`k${i}`, l)
    const warm = performance.now() - t
    console.log(`replay 40,000 reviews: cold ${Math.round(cold)} ms, from snapshot ${Math.round(warm)} ms`)
    expect(next.replays).toBe(0)
    expect(cold).toBeLessThan(5_000)
    expect(warm).toBeLessThan(cold)
  })
})
