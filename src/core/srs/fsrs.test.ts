import { describe, expect, test } from 'bun:test'
import type { Rating, Review } from '../contracts/workspace'
import {
  compareReviews,
  createScheduler,
  DAY_MS,
  dayStart,
  effectiveReviews,
  type GradedReview,
  localOffset,
  newCardState,
  reviewsByCard,
  studyDay,
} from './fsrs'

const T0 = Date.UTC(2026, 9, 1, 10, 0, 0)
const MIN = 60_000
const rv = (id: string, cardId: string, rating: Rating, at: number, dev = 'd1'): GradedReview => ({
  id,
  cardId,
  rating,
  at,
  ms: 3000,
  dev,
})

describe('effectiveReviews', () => {
  test('sorts by (at, id), drops voided reviews and clamps time', () => {
    const events: Review[] = [
      rv('b', 'c', 3, T0),
      rv('a', 'c', 3, T0),
      rv('z', 'c', 1, T0 - 5),
      { id: 'v', voids: 'z' },
    ]
    expect(effectiveReviews(events).map((r) => r.id)).toEqual(['a', 'b'])
    expect(compareReviews({ at: 1, id: 'a' }, { at: 1, id: 'a' })).toBe(0)
    expect(compareReviews({ at: 1, id: 'b' }, { at: 1, id: 'a' })).toBe(1)
    expect(compareReviews({ at: 0, id: 'b' }, { at: 1, id: 'a' })).toBeLessThan(0)
  })

  test('groups per card', () => {
    const m = reviewsByCard([rv('1', 'x', 3, T0), rv('2', 'y', 3, T0 + 1), rv('3', 'x', 3, T0 + 2)])
    expect(m.get('x')?.map((r) => r.id)).toEqual(['1', '3'])
    expect(m.get('y')?.length).toBe(1)
  })
})

describe('replay', () => {
  const log: Review[] = [
    rv('r1', 'c1', 3, T0),
    rv('r2', 'c1', 3, T0 + 10 * MIN),
    rv('r3', 'c1', 3, T0 + 3 * DAY_MS),
    rv('r4', 'c1', 1, T0 + 20 * DAY_MS),
    rv('r5', 'c1', 3, T0 + 20 * DAY_MS + 10 * MIN),
  ]

  test('is deterministic, independent of input order and of the scheduler instance', () => {
    const a = createScheduler().replay('c1', log)
    const b = createScheduler().replay('c1', [...log].reverse())
    expect(b).toEqual(a)
    expect(a.reps).toBe(5)
    expect(a.lapses).toBe(1)
    expect(a.phase).toBe('review')
    expect(a.history.map((h) => h.phaseBefore)).toEqual(['new', 'learning', 'review', 'review', 'relearning'])
  })

  test('same card reviewed offline on two devices converges to the same state', () => {
    const devA: Review[] = [rv('01A', 'c1', 3, T0), rv('03A', 'c1', 3, T0 + 2 * DAY_MS)]
    const devB: Review[] = [rv('02B', 'c1', 2, T0 + DAY_MS, 'd2'), rv('04B', 'c1', 4, T0 + 2 * DAY_MS, 'd2')]
    const mergedAB = createScheduler().replay('c1', [...devA, ...devB])
    const mergedBA = createScheduler().replay('c1', [...devB, ...devA])
    expect(mergedBA).toEqual(mergedAB)
    expect(mergedAB.reps).toBe(4)
  })

  test('negative elapsed time from a skewed clock is clamped to 0', () => {
    const skew: Review[] = [rv('a', 'c1', 3, T0), rv('b', 'c1', 3, T0 - DAY_MS)]
    const s = createScheduler().replay('c1', skew)
    expect(s.reps).toBe(2)
    expect(s.history.map((h) => h.reviewId)).toEqual(['b', 'a'])
  })

  test('undo: a void restores the previous state exactly', () => {
    const sch = createScheduler()
    const before = sch.replay('c1', log.slice(0, 3))
    const undone = sch.replay('c1', [
      ...log.slice(0, 3),
      rv('bad', 'c1', 1, T0 + 5 * DAY_MS),
      { id: 'u', voids: 'bad' },
    ])
    expect(undone).toEqual(before)
  })

  test('a card with no reviews is new; cache returns identical object', () => {
    const sch = createScheduler()
    expect(sch.replay('none', log)).toEqual(newCardState('none'))
    expect(sch.replay('c1', log)).toBe(sch.replay('c1', log))
  })

  test('learning steps are honoured', () => {
    const sch = createScheduler({ learningSteps: ['1m', '10m'], enableFuzz: false })
    const s = sch.replay('c', [rv('a', 'c', 3, T0)])
    expect(s.phase).toBe('learning')
    expect(s.due).toBe(T0 + 10 * MIN)
    const again = sch.replay('c', [rv('a', 'c', 1, T0)])
    expect(again.due).toBe(T0 + MIN)
  })

  test('relearning steps apply after a lapse', () => {
    const sch = createScheduler({ relearningSteps: ['15m'], enableFuzz: false })
    const s = sch.replay('c', [rv('a', 'c', 4, T0), rv('b', 'c', 1, T0 + 10 * DAY_MS)])
    expect(s.phase).toBe('relearning')
    expect(s.due).toBe(T0 + 10 * DAY_MS + 15 * MIN)
  })

  test('higher retention yields shorter intervals', () => {
    const reviews = [rv('a', 'c', 4, T0), rv('b', 'c', 3, T0 + 5 * DAY_MS)]
    const lo = createScheduler({ desiredRetention: 0.8, enableFuzz: false }).replay('c', reviews)
    const hi = createScheduler({ desiredRetention: 0.95, enableFuzz: false }).replay('c', reviews)
    expect(hi.due).toBeLessThan(lo.due)
  })

  test('replayAll covers every card', () => {
    const all = createScheduler().replayAll([...log, rv('x', 'c2', 3, T0)])
    expect([...all.keys()].sort()).toEqual(['c1', 'c2'])
  })

  test('previewIntervals orders Again < Hard < Good < Easy', () => {
    const sch = createScheduler({ enableFuzz: false })
    const s = sch.replay('c1', log.slice(0, 3))
    const p = sch.previewIntervals(s, T0 + 10 * DAY_MS)
    expect(p[1]).toBeLessThan(p[2])
    expect(p[2]).toBeLessThan(p[3])
    expect(p[3]).toBeLessThan(p[4])
    const fresh = sch.previewIntervals(newCardState('n'), T0)
    expect(fresh[1]).toBe(T0 + MIN)
  })
})

describe('study day', () => {
  test('starts at 04:00 local time', () => {
    const tz = 120 // UTC+2
    const at0359 = Date.UTC(2026, 9, 2, 1, 59) // 03:59 local
    const at0400 = Date.UTC(2026, 9, 2, 2, 0) // 04:00 local
    expect(studyDay(at0400, tz) - studyDay(at0359, tz)).toBe(1)
    expect(dayStart(studyDay(at0400, tz), tz)).toBe(at0400)
  })

  test('localOffset reflects the runtime zone', () => {
    expect(localOffset(T0)).toBe(-new Date(T0).getTimezoneOffset())
  })
})

describe('fuzz seeds', () => {
  const history = (cardId: string): Review[] => [
    rv(`${cardId}-1`, cardId, 3, T0),
    rv(`${cardId}-2`, cardId, 3, T0 + 10 * MIN),
    rv(`${cardId}-3`, cardId, 3, T0 + 3 * DAY_MS),
    rv(`${cardId}-4`, cardId, 3, T0 + 15 * DAY_MS),
  ]

  test('preview due equals the replayed due after logging that rating', () => {
    const s = createScheduler({ enableFuzz: true })
    const log = history('card-A')
    const state = s.replay('card-A', log)
    expect(state.phase).toBe('review')
    const now = T0 + 60 * DAY_MS
    const preview = s.previewIntervals(state, now)
    for (const rating of [1, 2, 3, 4] as Rating[]) {
      const after = createScheduler({ enableFuzz: true }).replay('card-A', [...log, rv('zz', 'card-A', rating, now)])
      expect(after.due).toBe(preview[rating])
    }
  })

  test('identical histories on different cards get different fuzzed due dates', () => {
    const s = createScheduler({ enableFuzz: true })
    const dues = new Set(['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map((id) => s.replay(id, history(id)).due))
    expect(dues.size).toBeGreaterThan(1)
  })
})
