import { describe, expect, test } from 'bun:test'
import type { Rating, Review } from '../contracts/workspace'
import { type CardState, createScheduler, DAY_MS, dayStart, studyDay } from './fsrs'
import { buildQueue, inScope, mixNew, orderNew, type QueueCard, stableRank, studyDayContext } from './queue'

const TZ = 0
const MIN = 60_000
const DAY0 = dayStart(studyDay(Date.UTC(2026, 9, 1, 12), TZ), TZ) // 04:00 UTC
const rv = (id: string, cardId: string, rating: Rating, at: number): Review => ({
  id,
  cardId,
  rating,
  at,
  ms: 1,
  dev: 'd',
})
const states = (log: Review[]): Map<string, CardState> => createScheduler({ enableFuzz: false }).replayAll(log)

describe('buildQueue', () => {
  test('learning first, then due reviews, then new cards within the daily limit; stable order', () => {
    const log: Review[] = [
      rv('a1', 'rev', 4, DAY0 - 30 * DAY_MS),
      rv('b1', 'lrn', 1, DAY0 + 60 * MIN),
      rv('c1', 'later', 4, DAY0 + 60 * MIN),
    ]
    const cards: QueueCard[] = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }, { id: 'later' }, { id: 'rev' }, { id: 'lrn' }]
    const q = buildQueue({ cards, states: states(log), now: DAY0 + 2 * 60 * MIN, tzOffsetMin: TZ, newPerDay: 3 }) // 2 new already introduced today
    expect(q).toEqual([
      { cardId: 'lrn', kind: 'learning' },
      { cardId: 'rev', kind: 'review' },
      { cardId: 'n1', kind: 'new' },
    ])
  })

  test('learning not yet due is held back', () => {
    const log = [rv('b1', 'lrn', 3, DAY0 + 60 * MIN)]
    const q = buildQueue({
      cards: [{ id: 'lrn' }],
      states: states(log),
      now: DAY0 + 61 * MIN,
      tzOffsetMin: TZ,
      newPerDay: 0,
    })
    expect(q).toEqual([])
  })

  test('siblings are buried for the day', () => {
    const log = [rv('a', 's1', 4, DAY0 + MIN)]
    const cards: QueueCard[] = [
      { id: 's1', sibling: 'f' },
      { id: 's2', sibling: 'f' },
      { id: 'g1', sibling: 'g' },
      { id: 'g2', sibling: 'g' },
    ]
    const q = buildQueue({ cards, states: states(log), now: DAY0 + 2 * MIN, tzOffsetMin: TZ, newPerDay: 10 })
    expect(q.map((e) => e.cardId)).toEqual(['g1'])
  })

  test('day rollover at 04:00 frees new-card budget and unburies siblings', () => {
    const log = [rv('a', 's1', 4, DAY0 + 23 * 60 * MIN)] // 03:00 next calendar day = same study day
    const cards: QueueCard[] = [{ id: 's1', sibling: 'f' }, { id: 's2', sibling: 'f' }, { id: 'n' }]
    const st = states(log)
    const before = buildQueue({ cards, states: st, now: DAY0 + DAY_MS - MIN, tzOffsetMin: TZ, newPerDay: 1 })
    expect(before).toEqual([])
    const after = buildQueue({ cards, states: st, now: DAY0 + DAY_MS, tzOffsetMin: TZ, newPerDay: 1 })
    expect(after).toEqual([{ cardId: 's2', kind: 'new' }])
  })

  test('undo gives the new card back', () => {
    const cards: QueueCard[] = [{ id: 'n' }]
    const log = [rv('a', 'n', 4, DAY0 + MIN)]
    const now = DAY0 + 2 * MIN
    expect(buildQueue({ cards, states: states(log), now, tzOffsetMin: TZ, newPerDay: 5 })).toEqual([])
    const undone = states([...log, { id: 'u', voids: 'a' }])
    expect(buildQueue({ cards, states: undone, now, tzOffsetMin: TZ, newPerDay: 5 })).toEqual([
      { cardId: 'n', kind: 'new' },
    ])
  })

  test('a scope queues its course or subset, descendants included', () => {
    const cards: QueueCard[] = [
      { id: 'root', courseId: 'law' },
      { id: 'ch', courseId: 'law', sections: ['contracts'] },
      { id: 'deep', courseId: 'law', sections: ['contracts', 'formation'] },
      { id: 'torts', courseId: 'law', sections: ['torts'] },
      { id: 'bio', courseId: 'bio' },
    ]
    const now = DAY0 + MIN
    const base = { cards, states: states([]), now, tzOffsetMin: TZ, newPerDay: 10 }
    const ids = (scope?: { courseId: string; sectionId?: string }) =>
      buildQueue({ ...base, ...(scope ? { scope } : {}) }).map((q) => q.cardId)
    expect(ids()).toEqual(['root', 'ch', 'deep', 'torts', 'bio'])
    expect(ids({ courseId: 'law' })).toEqual(['root', 'ch', 'deep', 'torts'])
    expect(ids({ courseId: 'law', sectionId: 'contracts' })).toEqual(['ch', 'deep'])
    expect(ids({ courseId: 'law', sectionId: 'formation' })).toEqual(['deep'])
    expect(ids({ courseId: 'bio', sectionId: 'contracts' })).toEqual([])
    expect(inScope({ id: 'x' }, { courseId: 'law' })).toBe(false)
    expect(inScope({ id: 'x', courseId: 'law' }, { courseId: 'law', sectionId: 's' })).toBe(false)
    expect(inScope({ id: 'x' }, undefined)).toBe(true)
    // A session scope: empty (every card) or a subset alone (section ids are unique).
    expect(inScope({ id: 'x', courseId: 'law' }, {})).toBe(true)
    expect(inScope({ id: 'x', courseId: 'law', sections: ['s'] }, { sectionId: 's' })).toBe(true)
    expect(inScope({ id: 'x', courseId: 'law' }, { sectionId: 's' })).toBe(false)
  })

  test("a scoped queue keeps the student's daily new-card budget and sibling burying", () => {
    const log = [rv('a', 'elsewhere', 3, DAY0 + MIN), rv('b', 'sib1', 3, DAY0 + MIN)]
    const cards: QueueCard[] = [
      { id: 'elsewhere', courseId: 'bio' },
      { id: 'sib1', courseId: 'bio', sibling: 'f' },
      { id: 'sib2', courseId: 'law', sections: ['s'], sibling: 'f' },
      { id: 'n1', courseId: 'law', sections: ['s'] },
      { id: 'n2', courseId: 'law', sections: ['s'] },
    ]
    const q = buildQueue({
      cards,
      states: states(log),
      now: DAY0 + 2 * MIN,
      tzOffsetMin: TZ,
      newPerDay: 3,
      scope: { courseId: 'law', sectionId: 's' },
    })
    expect(q).toEqual([{ cardId: 'n1', kind: 'new' }])
  })
})

describe('the settings of the day', () => {
  /** Five reviews due today (r1…r5), learning card l1 due now, new cards n1…n6. */
  function day() {
    const log: Review[] = [rv('l', 'l1', 1, DAY0 + 60 * MIN)]
    for (let i = 1; i <= 5; i++) log.push(rv(`r${i}`, `r${i}`, 4, DAY0 - 30 * DAY_MS + i * MIN))
    const cards: QueueCard[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `n${i + 1}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `r${i + 1}` })),
      { id: 'l1' },
    ]
    return { cards, states: states(log), now: DAY0 + 2 * 60 * MIN, tzOffsetMin: TZ }
  }
  const ids = (q: { cardId: string }[]) => q.map((e) => e.cardId)

  test('without settings, the queue is the same as before', () => {
    const d = day()
    expect(buildQueue({ ...d, newPerDay: 3 })).toEqual(
      buildQueue({ ...d, newPerDay: 3, newOrder: 'created', newMix: 'after' }),
    )
    // One new card was introduced today (l1, answered Again): two more come.
    expect(ids(buildQueue({ ...d, newPerDay: 3 }))).toEqual(['l1', 'r1', 'r2', 'r3', 'r4', 'r5', 'n1', 'n2'])
  })

  test('a review limit holds back reviews, then new cards; cards in learning never wait', () => {
    const d = day()
    // The card introduced today counts toward the limit: 4 left, all taken by reviews.
    expect(ids(buildQueue({ ...d, newPerDay: 3, maxReviews: 5 }))).toEqual(['l1', 'r1', 'r2', 'r3', 'r4'])
    expect(ids(buildQueue({ ...d, newPerDay: 3, maxReviews: 7 }))).toEqual(['l1', 'r1', 'r2', 'r3', 'r4', 'r5', 'n1'])
    expect(ids(buildQueue({ ...d, newPerDay: 3, maxReviews: 1 }))).toEqual(['l1'])
    expect(ids(buildQueue({ ...d, newPerDay: 3, maxReviews: 100 }))).toEqual(ids(buildQueue({ ...d, newPerDay: 3 })))
  })

  test('reviews answered today count toward the limit', () => {
    const log: Review[] = [
      rv('a', 'x', 4, DAY0 - 30 * DAY_MS),
      rv('b', 'y', 4, DAY0 - 30 * DAY_MS),
      rv('c', 'x', 3, DAY0 + MIN),
    ]
    const cards: QueueCard[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
    const input = { cards, states: states(log), now: DAY0 + 2 * MIN, tzOffsetMin: TZ, newPerDay: 5 }
    expect(studyDayContext(cards, input.states, input.now, TZ)).toMatchObject({ reviewsDoneToday: 1, newDoneToday: 0 })
    expect(ids(buildQueue({ ...input, maxReviews: 2 }))).toEqual(['y'])
    expect(ids(buildQueue({ ...input, maxReviews: 1 }))).toEqual([])
  })

  test('new cards in a random order that stays the same, whatever the order they are given in', () => {
    const d = day()
    const shuffled = ids(buildQueue({ ...d, newPerDay: 7, newOrder: 'random' })).filter((id) => id.startsWith('n'))
    expect([...shuffled].sort()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
    expect(shuffled).not.toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
    const reversed = { ...d, cards: [...d.cards].reverse() }
    expect(
      ids(buildQueue({ ...reversed, newPerDay: 7, newOrder: 'random' })).filter((id) => id.startsWith('n')),
    ).toEqual(shuffled)
    expect(stableRank('n1')).toBe(stableRank('n1'))
    expect(stableRank('n1')).not.toBe(stableRank('n2'))
    const fresh = [{ cardId: 'b' }, { cardId: 'a' }]
    expect(orderNew(fresh, undefined)).toEqual(fresh)
    expect(orderNew(fresh, 'created')).toEqual(fresh)
  })

  test('new cards before the reviews, or spread among them', () => {
    const d = day()
    expect(ids(buildQueue({ ...d, newPerDay: 3, newMix: 'before' }))).toEqual([
      'l1',
      'n1',
      'n2',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
    ])
    expect(ids(buildQueue({ ...d, newPerDay: 3, newMix: 'mixed' }))).toEqual([
      'l1',
      'r1',
      'r2',
      'n1',
      'r3',
      'n2',
      'r4',
      'r5',
    ])
    expect(mixNew([1, 2, 3, 4], [9], 'mixed')).toEqual([1, 2, 9, 3, 4])
    expect(mixNew([], [8, 9], 'mixed')).toEqual([8, 9])
    expect(mixNew([1, 2], [], 'mixed')).toEqual([1, 2])
    expect(mixNew([1], [7, 8, 9], 'mixed')).toEqual([7, 1, 8, 9])
  })
})

describe("a course's own limits", () => {
  /** Two courses: A with reviews a1…a3 due and new cards an1…an3, B the same (b1…b3, bn1…bn3). */
  function two() {
    const log: Review[] = []
    for (const c of ['a', 'b'])
      for (let i = 1; i <= 3; i++) log.push(rv(`${c}${i}`, `${c}${i}`, 4, DAY0 - 30 * DAY_MS + i * MIN))
    const cards: QueueCard[] = []
    for (const c of ['a', 'b']) {
      for (let i = 1; i <= 3; i++) cards.push({ id: `${c}${i}`, courseId: c.toUpperCase() })
      for (let i = 1; i <= 3; i++) cards.push({ id: `${c}n${i}`, courseId: c.toUpperCase() })
    }
    return { cards, states: states(log), now: DAY0 + 2 * 60 * MIN, tzOffsetMin: TZ }
  }
  const ids = (q: { cardId: string }[]) => q.map((e) => e.cardId)

  test('a course counts its own cards within the limits of all cards; the others have those only', () => {
    const d = two()
    const own = new Map([['A', { newPerDay: 1, maxReviews: 2 }]])
    // A: 2 reviews at most, new cards included, so its new card waits; B: everything, within 10 new a day.
    expect(ids(buildQueue({ ...d, newPerDay: 10, courseLimits: own }))).toEqual([
      'a1',
      'b1',
      'a2',
      'b2',
      'b3',
      'bn1',
      'bn2',
      'bn3',
    ])
    const fresh = new Map([['A', { newPerDay: 1 }]])
    expect(ids(buildQueue({ ...d, newPerDay: 10, courseLimits: fresh }))).toEqual([
      'a1',
      'b1',
      'a2',
      'b2',
      'a3',
      'b3',
      'an1',
      'bn1',
      'bn2',
      'bn3',
    ])
    // All cards' limits still bind: 2 new a day in all, whatever a course allows itself.
    const generous = new Map([['A', { newPerDay: 50 }]])
    expect(ids(buildQueue({ ...d, newPerDay: 2, courseLimits: generous })).filter((id) => id.includes('n'))).toEqual([
      'an1',
      'an2',
    ])
    expect(buildQueue({ ...d, newPerDay: 10, courseLimits: new Map() })).toEqual(buildQueue({ ...d, newPerDay: 10 }))
  })

  test('what a course did today counts toward its own limits only', () => {
    const log: Review[] = [
      rv('x', 'a1', 4, DAY0 - 30 * DAY_MS),
      rv('y', 'a2', 4, DAY0 - 30 * DAY_MS),
      rv('z', 'a1', 3, DAY0 + MIN),
      rv('w', 'bn0', 1, DAY0 + MIN),
    ]
    const cards: QueueCard[] = [
      { id: 'a1', courseId: 'A' },
      { id: 'a2', courseId: 'A' },
      { id: 'an1', courseId: 'A' },
      { id: 'bn0', courseId: 'B' },
      { id: 'bn1', courseId: 'B' },
    ]
    const s = states(log)
    const ctx = studyDayContext(cards, s, DAY0 + 2 * MIN, TZ)
    expect([...ctx.reviewsDoneBy]).toEqual([['A', 1]])
    expect([...ctx.newDoneBy]).toEqual([['B', 1]])
    const q = buildQueue({
      cards,
      states: s,
      now: DAY0 + 2 * MIN,
      tzOffsetMin: TZ,
      newPerDay: 10,
      courseLimits: new Map([
        ['A', { newPerDay: 5, maxReviews: 2 }],
        ['B', { newPerDay: 1 }],
      ]),
    })
    // A: one review done, one left (a2); its new card waits. B: its new card of the day is done.
    expect(ids(q)).toEqual(['bn0', 'a2'])
  })
})
