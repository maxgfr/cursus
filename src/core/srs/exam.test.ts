import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import type { Id, Rating } from '../contracts/workspace'
import { EXAM_GAP, EXAM_SIZE, type ExamAnswer, examBatch, examNext, examProgress, examStruggled, knows } from './exam'
import { type CardState, DAY_MS, newCardState } from './fsrs'

const NOW = Date.UTC(2026, 9, 1, 12)
const RUNS = { numRuns: Number(process.env.FC_RUNS ?? 100) }
const ids = (n: number): Id[] => Array.from({ length: n }, (_, i) => `c${String(i).padStart(3, '0')}`)
const a = (cardId: Id, rating: Rating): ExamAnswer => ({ cardId, rating })

/** A card in review, last seen `days` ago with this stability (higher: better remembered). */
function seen(cardId: Id, days: number, stability: number, lapses = 0): CardState {
  return {
    ...newCardState(cardId),
    phase: 'review',
    due: NOW + DAY_MS,
    lastReview: NOW - days * DAY_MS,
    stability,
    reps: 3,
    lapses,
  }
}

/** Plays a sitting: `misses` says how many times each card is missed (Again or Hard) before it is known. */
function play(batch: readonly Id[], misses: ReadonlyMap<Id, number>, miss: Rating = 1): ExamAnswer[] {
  const answers: ExamAnswer[] = []
  const left = new Map(misses)
  for (let next = examNext(batch, answers); next !== null; next = examNext(batch, answers)) {
    const n = left.get(next) ?? 0
    left.set(next, n - 1)
    answers.push(a(next, n > 0 ? miss : 3))
    if (answers.length > 10_000) throw new Error('the sitting never ends')
  }
  return answers
}

describe('examBatch', () => {
  test('a small part is taken whole; a large one gives the default size, never seen first', () => {
    const small = ids(12)
    expect(examBatch({ cards: small, states: new Map(), now: NOW, size: EXAM_SIZE.default }).sort()).toEqual(small)
    const big = ids(200)
    const states = new Map(big.slice(0, 150).map((id) => [id, seen(id, 1, 30)]))
    const batch = examBatch({ cards: big, states, now: NOW, size: EXAM_SIZE.default })
    expect(batch).toHaveLength(60)
    // The 50 never reviewed lead, in the part's order; then the weakest of the rest.
    expect(batch.slice(0, 50)).toEqual(big.slice(150))
  })

  test('the least likely recalled come first, then the most forgotten', () => {
    const states = new Map([
      ['strong', seen('strong', 1, 100)],
      ['weak', seen('weak', 20, 2)],
      ['mid', seen('mid', 5, 10, 0)],
      ['midLapsed', seen('midLapsed', 5, 10, 4)],
    ])
    const batch = examBatch({ cards: ['strong', 'mid', 'midLapsed', 'weak'], states, now: NOW, size: 3 })
    expect(batch).toEqual(['weak', 'midLapsed', 'mid'])
  })

  test('the next sitting of a plan goes on through the part instead of repeating the same cards', () => {
    const part = ids(130)
    const first = examBatch({ cards: part, states: new Map(), now: NOW, size: 60 })
    const sat = new Map(first.map((id, i) => [id, NOW + i]))
    const second = examBatch({ cards: part, states: new Map(), sat, now: NOW, size: 60 })
    expect(second.filter((id) => sat.has(id))).toEqual([])
    for (const [i, id] of second.entries()) sat.set(id, NOW + DAY_MS + i)
    // The third takes the last 10, then comes back to those gone over longest ago.
    const third = examBatch({ cards: part, states: new Map(), sat, now: NOW, size: 60 })
    expect(third.slice(0, 10).every((id) => !first.includes(id) && !second.includes(id))).toBe(true)
    expect(third.slice(10)).toEqual(first.slice(0, 50))
  })

  test('refuses a size that is not a positive whole number', () => {
    expect(() => examBatch({ cards: ids(3), states: new Map(), now: NOW, size: 0 })).toThrow(RangeError)
    expect(() => examBatch({ cards: ids(3), states: new Map(), now: NOW, size: 2.5 })).toThrow(RangeError)
  })

  test('property: a subset of the part, each card once, as large as it can be; unsat cards first', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 90 }),
        fc.integer({ min: 1, max: 80 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 1000 })), { maxLength: 40 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 60 })), { maxLength: 40 }),
        (picks, size, satPairs, statePairs) => {
          const cards = picks.map((n) => `k${n}`)
          const unique = new Set(cards)
          const sat = new Map(satPairs.map(([n, t]) => [`k${n}`, NOW + t]))
          const states = new Map(statePairs.map(([n, d]) => [`k${n}`, seen(`k${n}`, d, 1 + n)]))
          const batch = examBatch({ cards, states, sat, now: NOW, size })
          expect(batch).toHaveLength(Math.min(size, unique.size))
          expect(new Set(batch).size).toBe(batch.length)
          for (const id of batch) expect(unique.has(id)).toBe(true)
          // No card left out was gone over less lately than one taken.
          const latest = Math.max(...batch.map((id) => sat.get(id) ?? Number.NEGATIVE_INFINITY))
          for (const id of unique)
            if (!batch.includes(id)) expect(sat.get(id) ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(latest)
        },
      ),
      RUNS,
    )
  })

  test('property: consecutive sittings cover the whole part before any card comes back', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 300 }), fc.integer({ min: 50, max: 80 }), (n, size) => {
        const part = ids(n)
        const sat = new Map<Id, number>()
        const covered = new Set<Id>()
        const sittings = Math.ceil(n / size)
        for (let s = 0; s < sittings; s++) {
          const batch = examBatch({ cards: part, states: new Map(), sat, now: NOW, size })
          for (const id of batch) {
            if (covered.size < n) expect(covered.has(id)).toBe(false)
            covered.add(id)
            sat.set(id, NOW + s)
          }
        }
        expect(covered.size).toBe(n)
      }),
      RUNS,
    )
  })
})

describe('the sitting loop', () => {
  test('Good and Easy know a card; Again and Hard send it back', () => {
    expect(([1, 2, 3, 4] as const).map(knows)).toEqual([false, false, true, true])
  })

  test('a missed card comes back a few cards later, and the sitting ends once all are known', () => {
    const batch = ids(8)
    const [c0, c1, c2, c3, c4, c5, c6, c7] = batch as [Id, Id, Id, Id, Id, Id, Id, Id]
    const answers: ExamAnswer[] = [a(c0, 1)]
    expect(examProgress(batch, answers)).toEqual({ known: 0, total: 8, done: false })
    for (const id of [c1, c2, c3, c4]) {
      expect(examNext(batch, answers)).toBe(id)
      answers.push(a(id, 3))
    }
    // Four other answers since its miss: it comes back before the rest.
    expect(EXAM_GAP).toBe(4)
    expect(examNext(batch, answers)).toBe(c0)
    answers.push(a(c0, 2))
    expect(examNext(batch, answers)).toBe(c5)
    answers.push(a(c5, 4), a(c6, 3), a(c7, 3))
    // Nothing else waits: Hard sent it back, and it comes back at once.
    expect(examNext(batch, answers)).toBe(c0)
    expect(examProgress(batch, answers)).toEqual({ known: 7, total: 8, done: false })
    answers.push(a(c0, 3))
    expect(examNext(batch, answers)).toBeNull()
    expect(examProgress(batch, answers)).toEqual({ known: 8, total: 8, done: true })
    expect(examStruggled(batch, answers)).toEqual([{ cardId: c0, passes: 3 }])
  })

  test('a card known then missed is no longer known; answers outside the batch are ignored', () => {
    const batch = ['x', 'y']
    expect(examProgress(batch, [a('x', 3), a('x', 1), a('z', 1)])).toEqual({ known: 0, total: 2, done: false })
    expect(examNext(batch, [a('x', 3), a('x', 1), a('z', 1)])).toBe('y')
  })

  test('an empty batch is done from the start', () => {
    expect(examNext([], [])).toBeNull()
    expect(examProgress([], [])).toEqual({ known: 0, total: 0, done: true })
  })

  test('property: the next card is one not known yet, and there is one until all are known', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 24 }), fc.constantFrom<Rating>(1, 2, 3, 4)), { maxLength: 80 }),
        (n, raw) => {
          const batch = ids(n)
          const answers = raw.map(([k, r]) => a(`c${String(k).padStart(3, '0')}`, r))
          const next = examNext(batch, answers)
          const { done, known, total } = examProgress(batch, answers)
          expect(total).toBe(n)
          expect(known).toBeLessThanOrEqual(total)
          expect(next === null).toBe(done)
          if (next !== null) {
            expect(batch).toContain(next)
            const last = answers.findLast((x) => x.cardId === next)
            expect(last === undefined || !knows(last.rating)).toBe(true)
          }
        },
      ),
      RUNS,
    )
  })

  test('property: every card is shown, missed ones come back, and the sitting ends with all known', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 80 }),
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 80, maxLength: 80 }),
        fc.constantFrom<Rating>(1, 2),
        (n, missCounts, miss) => {
          const batch = ids(n)
          const misses = new Map(batch.map((id, i) => [id, missCounts[i] ?? 0]))
          const answers = play(batch, misses, miss)
          const expected = batch.reduce((sum, id) => sum + (misses.get(id) ?? 0) + 1, 0)
          expect(answers).toHaveLength(expected)
          expect(examProgress(batch, answers).done).toBe(true)
          // Never the same card twice in a row while another one still waits.
          for (let i = 1; i < answers.length; i++) {
            const prev = answers[i - 1] as ExamAnswer
            if (prev.cardId !== (answers[i] as ExamAnswer).cardId) continue
            expect(examProgress(batch, answers.slice(0, i)).known).toBe(n - 1)
          }
          const struggled = examStruggled(batch, answers)
          expect(struggled.map((s) => s.passes)).toEqual(struggled.map((s) => s.passes).sort((x, y) => y - x))
          expect(Object.fromEntries(struggled.map((s) => [s.cardId, s.passes - 1]))).toEqual(
            Object.fromEntries(batch.filter((id) => (misses.get(id) ?? 0) > 0).map((id) => [id, misses.get(id) ?? 0])),
          )
        },
      ),
      RUNS,
    )
  })
})
