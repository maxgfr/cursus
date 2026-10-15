import { describe, expect, test } from 'bun:test'
import type { Rating, Review } from '../contracts/workspace'
import { seededRng } from '../ports/rng'
import {
  createScheduler,
  DAY_MS,
  type GradedReview,
  isPractice,
  newCardState,
  retrievability,
  reviewsByCard,
  scheduledReviews,
} from './fsrs'

const T0 = Date.UTC(2026, 0, 5, 9, 0, 0)
let fresh = 0
// Every scheduler with the same parameters shares one cache: a maximum interval no history reaches gives a new one.
const freshScheduler = () => createScheduler({ maximumInterval: 60_000 + fresh++ })

const rv = (id: string, cardId: string, rating: Rating, at: number, p?: true): GradedReview => ({
  id,
  cardId,
  rating,
  at,
  ms: 1000,
  dev: 'd',
  sid: 's',
  ...(p ? { p } : {}),
})

/** A random history of several cards: scheduled and practice reviews mixed, some voided, shuffled. */
function randomLog(seed: number): { all: Review[]; scheduled: Review[] } {
  const rng = seededRng(seed)
  const all: Review[] = []
  const scheduled: Review[] = []
  for (const card of ['a', 'b', 'c']) {
    let t = T0
    const n = 4 + (rng.u32() % 14)
    for (let i = 0; i < n; i++) {
      t += (rng.u32() % 6) * DAY_MS + (rng.u32() % 120) * 60_000
      const practice = rng.u32() % 3 === 0
      const r = rv(
        `${card}-${String(i).padStart(2, '0')}`,
        card,
        ((rng.u32() % 4) + 1) as Rating,
        t,
        practice || undefined,
      )
      all.push(r)
      if (!practice) scheduled.push(r)
      // Practice reviews at the very same instant as a scheduled one, and a voided one now and then.
      if (rng.u32() % 4 === 0) all.push(rv(`${card}-${String(i).padStart(2, '0')}p`, card, 1, t, true))
      if (rng.u32() % 7 === 0) {
        const v = rv(`${card}-${String(i).padStart(2, '0')}v`, card, 4, t + 1)
        all.push(v, { id: `${v.id}-undo`, voids: v.id })
      }
    }
  }
  for (let i = all.length - 1; i > 0; i--) {
    const j = rng.u32() % (i + 1)
    const x = all[i] as Review
    all[i] = all[j] as Review
    all[j] = x
  }
  return { all, scheduled }
}

describe('practice reviews', () => {
  test('are recognised and kept out of the scheduled reviews', () => {
    const p = rv('1', 'a', 3, T0, true)
    const s = rv('2', 'a', 3, T0 + 1)
    expect(isPractice(p)).toBe(true)
    expect(isPractice(s)).toBe(false)
    expect(isPractice({ id: 'v', voids: '1' })).toBe(false)
    expect(scheduledReviews([p, s])).toEqual([s])
    expect([...reviewsByCard([p, s]).values()]).toEqual([[p, s]])
    expect([...reviewsByCard([p, s], { scheduled: true }).values()]).toEqual([[s]])
    expect(reviewsByCard([p], { scheduled: true }).size).toBe(0)
  })

  test('replay is deterministic and identical to the schedule without them, in any order', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { all, scheduled } = randomLog(seed)
      const truth = freshScheduler()
      for (const card of ['a', 'b', 'c']) {
        const expected = truth.replay(card, scheduled)
        expect(freshScheduler().replay(card, all)).toEqual(expected)
        expect(freshScheduler().replay(card, [...all].reverse())).toEqual(expected)
        expect(expected.history.every((h) => !h.reviewId.endsWith('p'))).toBe(true)
      }
      expect(freshScheduler().replayAll(all)).toEqual(truth.replayAll(scheduled))
    }
  })

  test('a warm cache serves the same state whether practice reviews come and go', () => {
    const sch = freshScheduler()
    const { all, scheduled } = randomLog(7)
    const first = sch.replay('a', scheduled)
    const before = sch.replays
    expect(sch.replay('a', all)).toEqual(first)
    expect(sch.replay('a', [...all, rv('late', 'a', 1, T0 + 999 * DAY_MS, true)])).toEqual(first)
    expect(sch.replays).toBe(before)
    // A scheduled review appended resumes from the cache, practice reviews around it changing nothing.
    const more = [...all, rv('z1', 'a', 3, T0 + 900 * DAY_MS), rv('z0', 'a', 1, T0 + 899 * DAY_MS, true)]
    expect(sch.replay('a', more)).toEqual(
      freshScheduler().replay('a', [...scheduled, rv('z1', 'a', 3, T0 + 900 * DAY_MS)]),
    )
    expect(sch.replays).toBe(before + 1)
  })

  test('a snapshot restored over a log with practice reviews replays nothing and gives the same states', () => {
    const { all, scheduled } = randomLog(11)
    const src = freshScheduler()
    const states = ['a', 'b', 'c'].map((c) => src.replay(c, all))
    const next = freshScheduler()
    next.restore({ ...structuredClone(src.snapshot()), params: next.snapshot().params })
    expect(['a', 'b', 'c'].map((c) => next.replay(c, scheduled))).toEqual(states)
    expect(['a', 'b', 'c'].map((c) => next.replay(c, [...all, rv('x', 'b', 2, T0, true)]))).toEqual(states)
    expect(next.replays).toBe(0)
  })

  test('retrievability: none for a new card, falling with time, higher with stability', () => {
    expect(retrievability(newCardState('n'), T0)).toBe(0)
    const s = freshScheduler().replay('r', [rv('1', 'r', 3, T0), rv('2', 'r', 3, T0 + 3 * DAY_MS)])
    const at = (days: number) => retrievability(s, (s.lastReview ?? 0) + days * DAY_MS)
    expect(at(0)).toBeCloseTo(1, 6)
    expect(at(1)).toBeLessThan(at(0))
    expect(at(30)).toBeLessThan(at(1))
    expect(at(-5)).toBeCloseTo(1, 6)
    const stronger = { ...s, stability: s.stability * 4 }
    expect(retrievability(stronger, (s.lastReview ?? 0) + 10 * DAY_MS)).toBeGreaterThan(at(10))
    expect(retrievability({ ...s, stability: 0 }, T0)).toBe(0)
  })
})
