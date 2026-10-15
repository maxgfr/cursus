import { describe, expect, test } from 'bun:test'
import type { Id, Rating, Review, SessionKind } from '../contracts/workspace'
import { buildSession, DEFAULT_SESSION_DAYS, SESSION_KINDS, type SessionQueueInput } from './custom'
import { type CardState, createScheduler, DAY_MS, dayStart, newCardState, retrievability, studyDay } from './fsrs'
import { buildQueue, type QueueCard } from './queue'

const TZ = 0
const MIN = 60_000
const DAY0 = dayStart(studyDay(Date.UTC(2026, 9, 1, 12), TZ), TZ) // 04:00 UTC
const NOW = DAY0 + 2 * 60 * MIN
const rv = (id: string, cardId: string, rating: Rating, at: number): Review => ({
  id,
  cardId,
  rating,
  at,
  ms: 1,
  dev: 'd',
})
const states = (log: Review[]): Map<Id, CardState> => createScheduler({ enableFuzz: false }).replayAll(log)
const ids = (q: { cardId: Id }[]): Id[] => q.map((e) => e.cardId)

/** A state as the scheduler would give it, built by hand so each case says exactly what it tests. */
function st(
  cardId: Id,
  phase: CardState['phase'],
  due: number,
  lastReview: number,
  stability: number,
  history: { rating: Rating; at: number }[] = [{ rating: 3, at: lastReview }],
): CardState {
  return {
    ...newCardState(cardId),
    phase,
    due,
    lastReview,
    stability,
    reps: history.length,
    history: history.map((h, i) => ({ reviewId: `${cardId}${i}`, phaseBefore: 'review' as const, ...h })),
  }
}

/**
 * - `lrn`: failed half an hour into today, relearning and due now;
 * - `rev`: a review due today; `soon`: due in three days; `far`: due in three months;
 * - `n1`, `n2`, `n3`: never reviewed.
 */
function fixture(): { cards: QueueCard[]; states: Map<Id, CardState> } {
  const list = [
    st('lrn', 'relearning', NOW - MIN, DAY0 + 30 * MIN, 1, [
      { rating: 3, at: DAY0 - 40 * DAY_MS },
      { rating: 1, at: DAY0 + 30 * MIN },
    ]),
    st('rev', 'review', DAY0 + 10 * 60 * MIN, DAY0 - 20 * DAY_MS, 15),
    st('soon', 'review', DAY0 + 3 * DAY_MS, DAY0 - 5 * DAY_MS, 8),
    st('far', 'review', DAY0 + 90 * DAY_MS, DAY0 - DAY_MS, 90),
  ]
  const cards: QueueCard[] = ['lrn', 'rev', 'soon', 'far', 'n1', 'n2', 'n3'].map((id) => ({ id, courseId: 'law' }))
  return { cards, states: new Map(list.map((s) => [s.cardId, s])) }
}

function input(kind: SessionKind, extra: Partial<SessionQueueInput> = {}): SessionQueueInput {
  const { cards, states } = fixture()
  return { cards, states, now: NOW, tzOffsetMin: TZ, newPerDay: 2, kind, ...extra }
}

describe('buildSession', () => {
  test('due: learning due now, then reviews due today, never new cards; the same cards as the daily queue', () => {
    const i = input('due')
    expect(buildSession(i)).toEqual([
      { cardId: 'lrn', kind: 'learning' },
      { cardId: 'rev', kind: 'review' },
    ])
    const daily = buildQueue({ ...i, newPerDay: 0 })
    expect(ids(buildSession(i))).toEqual(ids(daily))
    expect(ids(buildSession({ ...i, limit: 1 }))).toEqual(['lrn'])
    expect(buildSession({ ...i, limit: 0 })).toEqual([])
  })

  test('ahead: cards already seen falling due within the window, soonest first', () => {
    expect(ids(buildSession(input('ahead')))).toEqual(['lrn', 'rev', 'soon'])
    expect(ids(buildSession(input('ahead', { days: 1 })))).toEqual(['lrn', 'rev'])
    expect(ids(buildSession(input('ahead', { days: 365 })))).toEqual(['lrn', 'rev', 'soon', 'far'])
    expect(ids(buildSession(input('ahead', { limit: 2 })))).toEqual(['lrn', 'rev'])
  })

  test('failed: Again within the last days, practice ones included, oldest failure first', () => {
    const { cards, states } = fixture()
    const all = [
      { cardId: 'lrn', rating: 1 as const, at: DAY0 + 30 * MIN },
      { cardId: 'rev', rating: 3 as const, at: DAY0 - DAY_MS },
      { cardId: 'soon', rating: 1 as const, at: DAY0 - DAY_MS },
      { cardId: 'far', rating: 1 as const, at: DAY0 - 10 * DAY_MS },
      { cardId: 'n1', rating: 1 as const, at: DAY0 + MIN },
    ]
    const base = { cards, states, now: NOW, tzOffsetMin: TZ, newPerDay: 0, kind: 'failed' as const }
    // Without the log of every review, only the scheduled histories show failures.
    expect(ids(buildSession(base))).toEqual(['lrn'])
    // `n1` is new for the schedule (failed in practice only): a session that counts keeps it within the budget.
    expect(ids(buildSession({ ...base, reviews: all }))).toEqual(['soon', 'lrn'])
    expect(ids(buildSession({ ...base, reviews: all, practice: true }))).toEqual(['soon', 'n1', 'lrn'])
    expect(ids(buildSession({ ...base, reviews: all, practice: true, days: 30 }))).toEqual(['far', 'soon', 'n1', 'lrn'])
    // A failure after `now` (a skewed clock) does not count yet.
    const future = [{ cardId: 'rev', rating: 1 as const, at: NOW + DAY_MS }]
    expect(ids(buildSession({ ...base, reviews: future }))).toEqual([])
  })

  test('relaunch: a failed session over given cards keeps their order, whatever the window', () => {
    const i = input('failed', { cardIds: ['far', 'gone', 'rev'], practice: true })
    expect(ids(buildSession(i))).toEqual(['far', 'rev'])
    expect(ids(buildSession({ ...i, cardIds: ['rev', 'far'] }))).toEqual(['rev', 'far'])
    // Other kinds keep their own selection and order among the given cards.
    expect(ids(buildSession(input('due', { cardIds: ['rev', 'n1'] })))).toEqual(['rev'])
  })

  test('new: never-reviewed cards within the day budget, unless practice', () => {
    expect(ids(buildSession(input('new')))).toEqual(['n1', 'n2'])
    expect(ids(buildSession(input('new', { practice: true })))).toEqual(['n1', 'n2', 'n3'])
    expect(ids(buildSession(input('new', { practice: true, limit: 1 })))).toEqual(['n1'])
    // Cards introduced today (any course) use the budget up.
    const { cards, states } = fixture()
    states.set('n3', st('n3', 'learning', NOW + DAY_MS, DAY0 + MIN, 1))
    const q = buildSession({ cards, states, now: NOW, tzOffsetMin: TZ, newPerDay: 2, kind: 'new' })
    expect(ids(q)).toEqual(['n1'])
  })

  test('all: lowest estimated retention first, then new cards', () => {
    const i = input('all', { practice: true })
    const q = buildSession(i)
    expect(ids(q)).toEqual(['rev', 'soon', 'lrn', 'far', 'n1', 'n2', 'n3'])
    const r = (id: Id) => retrievability(i.states.get(id) as CardState, NOW)
    expect(r('rev')).toBeLessThan(r('soon'))
    expect(r('soon')).toBeLessThan(r('lrn'))
    expect(r('lrn')).toBeLessThan(r('far'))
    expect(q.map((e) => e.kind)).toEqual(['review', 'review', 'learning', 'review', 'new', 'new', 'new'])
    // Counting in the schedule: new cards stay within the budget.
    expect(ids(buildSession(input('all')))).toEqual(['rev', 'soon', 'lrn', 'far', 'n1', 'n2'])
  })

  test('scope: a course, a subset with its descendants, a subset alone, or everything', () => {
    const cards: QueueCard[] = [
      { id: 'root', courseId: 'law' },
      { id: 'ch', courseId: 'law', sections: ['contracts'] },
      { id: 'deep', courseId: 'law', sections: ['contracts', 'formation'] },
      { id: 'bio', courseId: 'bio' },
    ]
    const base = { cards, states: states([]), now: NOW, tzOffsetMin: TZ, newPerDay: 10, kind: 'new' as const }
    expect(ids(buildSession(base))).toEqual(['root', 'ch', 'deep', 'bio'])
    expect(ids(buildSession({ ...base, scope: {} }))).toEqual(['root', 'ch', 'deep', 'bio'])
    expect(ids(buildSession({ ...base, scope: { courseId: 'law' } }))).toEqual(['root', 'ch', 'deep'])
    expect(ids(buildSession({ ...base, scope: { courseId: 'law', sectionId: 'contracts' } }))).toEqual(['ch', 'deep'])
    expect(ids(buildSession({ ...base, scope: { sectionId: 'formation' } }))).toEqual(['deep'])
    expect(ids(buildSession({ ...base, scope: { courseId: 'bio', sectionId: 'contracts' } }))).toEqual([])
  })

  test('siblings: buried for the day once one was reviewed, one per group in a session; learning keeps its slot', () => {
    const log = [rv('a', 's1', 4, DAY0 + MIN), rv('b', 'l1', 1, DAY0 + MIN)]
    const cards: QueueCard[] = [
      { id: 's1', sibling: 'f' },
      { id: 's2', sibling: 'f' },
      { id: 'g1', sibling: 'g' },
      { id: 'g2', sibling: 'g' },
      { id: 'l1', sibling: 'h' },
      { id: 'l2', sibling: 'h' },
    ]
    const base = { cards, states: states(log), now: NOW, tzOffsetMin: TZ, newPerDay: 10, practice: true }
    expect(ids(buildSession({ ...base, kind: 'new' }))).toEqual(['g1'])
    expect(ids(buildSession({ ...base, kind: 'all' }))).toEqual(['l1', 'g1'])
    expect(ids(buildSession({ ...base, kind: 'due' }))).toEqual(['l1'])
  })

  test('invalid requests are refused', () => {
    expect(() => buildSession(input('bogus' as SessionKind))).toThrow(RangeError)
    expect(() => buildSession(input('due', { limit: -1 }))).toThrow(RangeError)
    expect(() => buildSession(input('due', { limit: 1.5 }))).toThrow(RangeError)
    expect(() => buildSession(input('ahead', { days: 0 }))).toThrow(RangeError)
    expect(SESSION_KINDS).toEqual(['due', 'ahead', 'failed', 'new', 'all'])
    expect(DEFAULT_SESSION_DAYS).toBe(7)
  })
})
