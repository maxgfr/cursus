import { describe, expect, test } from 'bun:test'
import type { Rating, Review } from '../contracts/workspace'
import { type CardState, createScheduler, DAY_MS, dayStart, studyDay } from './fsrs'
import { buildQueue, inScope, type QueueCard } from './queue'

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
