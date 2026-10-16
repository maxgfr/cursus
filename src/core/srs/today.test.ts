import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import type { Id } from '../contracts/workspace'
import { type CardState, DAY_MS, newCardState } from './fsrs'
import { EXAM_WINDOW_DAYS } from './planner'
import type { QueueEntry } from './queue'
import { FRAGILE_LAPSES, inTodayOrder, planToday, type TodayInput } from './today'

const NOW = Date.UTC(2026, 9, 1, 12)
const TZ = 0
const RUNS = { numRuns: Number(process.env.FC_RUNS ?? 100) }
const kinds = fc.constantFrom<QueueEntry['kind']>('learning', 'review', 'new')

/** A card in review, due `dueIn` days from now (negative: overdue), seen `ago` days ago with this stability. */
function review(cardId: Id, dueIn: number, o: { ago?: number; stability?: number; lapses?: number } = {}): CardState {
  return {
    ...newCardState(cardId),
    phase: 'review',
    due: NOW + dueIn * DAY_MS,
    lastReview: NOW - (o.ago ?? 1) * DAY_MS,
    stability: o.stability ?? 100,
    reps: 3,
    lapses: o.lapses ?? 0,
  }
}

function learning(cardId: Id): CardState {
  return { ...newCardState(cardId), phase: 'relearning', due: NOW - 60_000, lastReview: NOW - 600_000, stability: 1 }
}

/** A plan's input from cards given as [id, course, kind, state]. */
function input(
  courses: Id[],
  cards: [Id, Id, QueueEntry['kind'], CardState?][],
  exams: [Id, number][] = [],
): TodayInput {
  const states = new Map<Id, CardState>()
  for (const [id, , , s] of cards) if (s) states.set(id, s)
  return {
    courses,
    courseOf: new Map(cards.map(([id, course]) => [id, course])),
    queue: cards.map(([cardId, , kind]) => ({ cardId, kind })),
    states,
    exams: new Map(exams),
    now: NOW,
    tzOffsetMin: TZ,
  }
}

describe('planToday', () => {
  test('an exam within the window leads, then the most behind, the most fragile, the most reviews, new only', () => {
    const plan = planToday(
      input(
        ['fresh', 'due', 'fragile', 'late', 'exam'],
        [
          ['f1', 'fresh', 'new'],
          ['f2', 'fresh', 'new'],
          ['d1', 'due', 'review', review('d1', 0)],
          ['g1', 'fragile', 'review', review('g1', 0, { lapses: FRAGILE_LAPSES })],
          ['l1', 'late', 'review', review('l1', -3)],
          ['e1', 'exam', 'new'],
        ],
        [['exam', 4]],
      ),
    )
    expect(plan.map((c) => c.courseId)).toEqual(['exam', 'late', 'fragile', 'due', 'fresh'])
    expect(plan.map((c) => c.reason)).toEqual([
      { kind: 'exam', days: 4 },
      { kind: 'late', count: 1 },
      { kind: 'fragile', count: 1 },
      { kind: 'due', count: 1 },
      { kind: 'new', count: 2 },
    ])
  })

  test('an exam past the window, or past, does not lead; ties keep the student’s order', () => {
    const plan = planToday(
      input(
        ['a', 'b', 'c'],
        [
          ['a1', 'a', 'new'],
          ['b1', 'b', 'new'],
          ['c1', 'c', 'new'],
        ],
        [
          ['b', EXAM_WINDOW_DAYS + 1],
          ['c', -1],
        ],
      ),
    )
    expect(plan.map((c) => c.courseId)).toEqual(['a', 'b', 'c'])
    expect(plan[1]?.examDays).toBe(EXAM_WINDOW_DAYS + 1)
    expect(plan[2]?.examDays).toBeNull()
  })

  test('within a tier: the nearest exam, then the largest count', () => {
    const plan = planToday(
      input(
        ['far', 'near', 'one', 'two'],
        [
          ['n1', 'near', 'new'],
          ['f1', 'far', 'new'],
          ['o1', 'one', 'review', review('o1', -1)],
          ['t1', 'two', 'review', review('t1', -1)],
          ['t2', 'two', 'review', review('t2', -2)],
        ],
        [
          ['far', 6],
          ['near', 0],
        ],
      ),
    )
    expect(plan.map((c) => c.courseId)).toEqual(['near', 'far', 'two', 'one'])
  })

  test('counts each kind; late is due before today’s study day; fragile from recall or lapses', () => {
    // Due earlier today (after 04:00) is not late; often forgotten, or seen long ago with a small stability: fragile.
    const [c] = planToday(
      input(
        ['x'],
        [
          ['r1', 'x', 'review', review('r1', -0.1, { lapses: FRAGILE_LAPSES })],
          ['r2', 'x', 'review', review('r2', -2, { ago: 30, stability: 2 })],
          ['l1', 'x', 'learning', learning('l1')],
          ['n1', 'x', 'new'],
        ],
      ),
    )
    expect(c).toMatchObject({ total: 4, learning: 1, review: 2, fresh: 1, late: 1, fragile: 2, examDays: null })
  })

  test('a course with nothing queued, or unknown, is not listed', () => {
    const plan = planToday(
      input(
        ['a', 'b'],
        [
          ['a1', 'a', 'new'],
          ['z1', 'zz', 'new'],
        ],
      ),
    )
    expect(plan.map((c) => c.courseId)).toEqual(['a'])
  })

  const arbInput = fc
    .record({
      courses: fc.uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { minLength: 1 }),
      cards: fc.array(
        fc.record({
          course: fc.constantFrom('a', 'b', 'c', 'd', 'e'),
          kind: kinds,
          dueIn: fc.double({ min: -30, max: 0.5, noNaN: true }),
          ago: fc.double({ min: 0, max: 60, noNaN: true }),
          stability: fc.double({ min: 0.1, max: 365, noNaN: true }),
          lapses: fc.nat(10),
        }),
        { maxLength: 60 },
      ),
      exams: fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd', 'e'), fc.integer({ min: -5, max: 30 })),
    })
    .map(({ courses, cards, exams }) =>
      input(
        courses,
        cards.map((c, n) => {
          const id = `k${n}`
          const s = c.kind === 'new' ? undefined : c.kind === 'learning' ? learning(id) : review(id, c.dueIn, c)
          return [id, c.course, c.kind, s] as [Id, Id, QueueEntry['kind'], CardState?]
        }),
        Object.entries(exams),
      ),
    )

  test('property: the shares add up to the queue (no card twice, none outside it), each coherent', () => {
    fc.assert(
      fc.property(arbInput, (i) => {
        const plan = planToday(i)
        const listed = new Set(i.courses)
        const queued = i.queue.filter((q) => listed.has(i.courseOf.get(q.cardId) ?? '')).length
        expect(plan.reduce((n, c) => n + c.total, 0)).toBe(queued)
        expect(new Set(plan.map((c) => c.courseId)).size).toBe(plan.length)
        for (const c of plan) {
          expect(listed.has(c.courseId)).toBe(true)
          expect(c.total).toBeGreaterThan(0)
          expect(c.learning + c.review + c.fresh).toBe(c.total)
          expect(c.late).toBeLessThanOrEqual(c.review)
          expect(c.fragile).toBeLessThanOrEqual(c.learning + c.review)
          if (c.reason.kind !== 'exam') expect(c.reason.count).toBeGreaterThan(0)
        }
      }),
      RUNS,
    )
  })

  test('property: the order never puts a lower tier first, and exams go nearest first', () => {
    const tier = ['exam', 'late', 'fragile', 'due', 'new']
    fc.assert(
      fc.property(arbInput, (i) => {
        const plan = planToday(i)
        for (let n = 1; n < plan.length; n++) {
          const a = plan[n - 1]?.reason
          const b = plan[n]?.reason
          if (!a || !b) continue
          expect(tier.indexOf(a.kind)).toBeLessThanOrEqual(tier.indexOf(b.kind))
          if (a.kind === 'exam' && b.kind === 'exam') expect(a.days).toBeLessThanOrEqual(b.days)
          if (a.kind === b.kind && a.kind !== 'exam' && b.kind !== 'exam')
            expect(a.count).toBeGreaterThanOrEqual(b.count)
        }
      }),
      RUNS,
    )
  })
})

describe('inTodayOrder', () => {
  test('learning steps first, then course by course in the plan’s order, the queue’s order within', () => {
    const queue: QueueEntry[] = [
      { cardId: 'b1', kind: 'review' },
      { cardId: 'a1', kind: 'review' },
      { cardId: 'b2', kind: 'learning' },
      { cardId: 'a2', kind: 'new' },
      { cardId: 'b3', kind: 'new' },
      { cardId: 'z1', kind: 'review' },
    ]
    const courseOf = new Map([
      ['a1', 'a'],
      ['a2', 'a'],
      ['b1', 'b'],
      ['b2', 'b'],
      ['b3', 'b'],
    ])
    const ordered = inTodayOrder(queue, [{ courseId: 'a' }, { courseId: 'b' }], courseOf)
    expect(ordered.map((q) => q.cardId)).toEqual(['b2', 'a1', 'a2', 'b1', 'b3', 'z1'])
  })

  test('property: the same cards, learning first, each course in one run in the plan’s order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ course: fc.constantFrom('a', 'b', 'c'), kind: kinds }), { maxLength: 40 }),
        fc.shuffledSubarray(['a', 'b', 'c']),
        (cards, order) => {
          const queue = cards.map((c, n) => ({ cardId: `k${n}`, kind: c.kind }))
          const courseOf = new Map(cards.map((c, n) => [`k${n}`, c.course]))
          const out = inTodayOrder(
            queue,
            order.map((courseId) => ({ courseId })),
            courseOf,
          )
          expect([...out].sort((x, y) => (x.cardId < y.cardId ? -1 : 1))).toEqual(
            [...queue].sort((x, y) => (x.cardId < y.cardId ? -1 : 1)),
          )
          const rank = (q: QueueEntry) =>
            q.kind === 'learning' ? -1 : order.indexOf(courseOf.get(q.cardId) ?? '') + 1 || order.length + 1
          for (let n = 1; n < out.length; n++) {
            const a = out[n - 1]
            const b = out[n]
            if (!a || !b) continue
            expect(rank(a)).toBeLessThanOrEqual(rank(b))
            if (rank(a) === rank(b)) expect(queue.indexOf(a)).toBeLessThan(queue.indexOf(b))
          }
        },
      ),
      RUNS,
    )
  })
})
