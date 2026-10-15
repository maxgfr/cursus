import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import type { Id, PlanInput, Rating } from '../contracts/workspace'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { createScheduler, DAY_MS } from '../srs/fsrs'
import { canonicalJson } from '../sync/verify'
import { EntityNotFoundError } from './repos'
import { type PlanRecord, ROOT, type SessionEvent } from './schema'
import {
  nextOccurrence,
  nextPlanned,
  parseTime,
  planScope,
  planSession,
  relaunchFailed,
  SessionInputError,
  sessionHistory,
  sessionQueue,
  sessionReview,
  summarize,
} from './sessions'
import { createWorkspace, type ModelWorkspace } from './workspace'

// Wednesday 2026-10-14, 10:00 UTC.
const NOW = Date.UTC(2026, 9, 14, 10, 0, 0)
const MIN = 60_000

function make(seed: number, dev = `d${seed}`) {
  const doc = new Y.Doc()
  const clock = virtualClock(NOW)
  return { doc, clock, w: createWorkspace(doc, { rng: seededRng(seed, clock), clock, deviceId: dev }) }
}

function sync(a: Y.Doc, b: Y.Doc): void {
  const ua = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b))
  const ub = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a))
  Y.applyUpdateV2(b, ua)
  Y.applyUpdateV2(a, ub)
}

function deck(w: ModelWorkspace, n: number, courseId?: Id): { course: Id; cards: Id[] } {
  const course = courseId ?? w.courses.create({ title: 'Law' })
  const cards = Array.from({ length: n }, () => w.cards.create({ courseId: course, kind: 'basic' }))
  return { course, cards }
}

const events = (w: ModelWorkspace): SessionEvent[] => w.sessions.yArray.toArray()

describe('session log', () => {
  test('a start is one event, an end another appended; nothing is rewritten', () => {
    const { w, clock } = make(1)
    const a = w.sessions.start({ scope: { courseId: 'c', sectionId: undefined }, kind: 'due', practice: false })
    clock.advance(MIN)
    const b = w.sessions.start({ scope: {}, kind: 'all', limit: 30, practice: true, planId: 'p', cardIds: ['x'] })
    expect(events(w)).toEqual([
      { id: a, startedAt: NOW, dev: 'd1', scope: { courseId: 'c' }, kind: 'due', practice: false },
      {
        id: b,
        startedAt: NOW + MIN,
        dev: 'd1',
        scope: {},
        kind: 'all',
        practice: true,
        limit: 30,
        planId: 'p',
        cardIds: ['x'],
      },
    ])
    expect(w.sessions.list().map((s) => s.id)).toEqual([b, a])
    expect(w.sessions.get(a)).toEqual({ id: a, startedAt: NOW, scope: { courseId: 'c' }, kind: 'due', practice: false })
    clock.advance(5 * MIN)
    w.sessions.end(a)
    const before = events(w).slice(0, 2)
    expect(events(w).length).toBe(3)
    expect(events(w).slice(0, 2)).toEqual(before)
    expect(events(w)[2]).toMatchObject({ ends: a, endedAt: NOW + 6 * MIN })
    expect(w.sessions.get(a)?.endedAt).toBe(NOW + 6 * MIN)
    // Ending again writes nothing.
    w.sessions.end(a)
    expect(events(w).length).toBe(3)
    expect(w.sessions.get(b)?.endedAt).toBeUndefined()
    expect(() => w.sessions.end('nope')).toThrow(EntityNotFoundError)
  })

  test('invalid sessions are refused', () => {
    const { w } = make(2)
    expect(() => w.sessions.start({ scope: {}, kind: 'bogus' as 'due', practice: false })).toThrow(SessionInputError)
    expect(() => w.sessions.start({ scope: {}, kind: 'due', practice: false, limit: 0 })).toThrow(SessionInputError)
    expect(() => w.sessions.start({ scope: {}, kind: 'due', practice: false, limit: 2.5 })).toThrow(RangeError)
    expect(events(w)).toEqual([])
  })

  test('ends from two devices merge: the earliest wins, everywhere', () => {
    const a = make(3)
    const b = make(4)
    const id = a.w.sessions.start({ scope: {}, kind: 'new', practice: false })
    sync(a.doc, b.doc)
    a.clock.advance(10 * MIN)
    b.clock.advance(4 * MIN)
    a.w.sessions.end(id)
    b.w.sessions.end(id)
    sync(a.doc, b.doc)
    expect(a.w.sessions.get(id)?.endedAt).toBe(NOW + 4 * MIN)
    expect(b.w.sessions.list()).toEqual(a.w.sessions.list())
    // An end never precedes its start, even from a device whose clock is behind.
    const c = make(5)
    const late = c.w.sessions.start({ scope: {}, kind: 'new', practice: false })
    c.clock.set(NOW - DAY_MS)
    c.w.sessions.end(late)
    expect(c.w.sessions.get(late)?.endedAt).toBe(NOW)
  })

  test('a session that already took place: started and ended at the times given', () => {
    const { w } = make(6)
    const from = NOW - 2 * DAY_MS
    const id = w.sessions.start({ scope: { courseId: 'c' }, kind: 'all', practice: true, limit: 5 }, from)
    w.sessions.end(id, from + MIN)
    expect(events(w)).toEqual([
      { id, startedAt: from, dev: 'd6', scope: { courseId: 'c' }, kind: 'all', practice: true, limit: 5 },
      { id: expect.any(String), ends: id, endedAt: from + MIN },
    ])
    expect(w.sessions.get(id)).toEqual({
      id,
      startedAt: from,
      endedAt: from + MIN,
      scope: { courseId: 'c' },
      kind: 'all',
      practice: true,
      limit: 5,
    })
    // Never ended before it started; a time that is not one is refused, nothing written.
    const other = w.sessions.start({ scope: {}, kind: 'due', practice: false }, from)
    w.sessions.end(other, from - DAY_MS)
    expect(w.sessions.get(other)?.endedAt).toBe(from)
    expect(() => w.sessions.start({ scope: {}, kind: 'due', practice: false }, Number.NaN)).toThrow(SessionInputError)
    expect(() => w.sessions.end(id, Number.POSITIVE_INFINITY)).toThrow(SessionInputError)
    expect(events(w).length).toBe(4)
  })
})

describe('session reviews', () => {
  test('carry the session id, and p only in practice; older reviews without them stay valid', () => {
    const { w } = make(6)
    const { cards } = deck(w, 1)
    const card = cards[0] as Id
    const old = w.reviews.record({ cardId: card, rating: 3, at: NOW - 10 * DAY_MS, ms: 1000 })
    const cram = w.sessions.start({ scope: {}, kind: 'all', practice: true })
    const real = w.sessions.start({ scope: {}, kind: 'due', practice: false })
    const p = w.reviews.record(
      sessionReview({ id: cram, practice: true }, { cardId: card, rating: 1, at: NOW, ms: 500 }),
    )
    const r = w.reviews.record(
      sessionReview({ id: real, practice: false }, { cardId: card, rating: 3, at: NOW + MIN, ms: 700, p: true }),
    )
    const log = w.reviews.yArray.toArray()
    expect(log[0]).toEqual({ id: old, cardId: card, rating: 3, at: NOW - 10 * DAY_MS, ms: 1000, dev: 'd6' })
    expect(log[1]).toEqual({ id: p, cardId: card, rating: 1, at: NOW, ms: 500, dev: 'd6', sid: cram, p: true })
    expect(log[2]).toEqual({ id: r, cardId: card, rating: 3, at: NOW + MIN, ms: 700, dev: 'd6', sid: real })
    expect(w.reviews.forSession(cram).map((e) => e.id)).toEqual([p])
    expect(w.reviews.forSession(real).map((e) => e.id)).toEqual([r])
    expect(w.reviews.forSession('none')).toEqual([])
    expect(w.reviews.all().map((e) => e.id)).toEqual([old, p, r])
    // The schedule ignores the practice review.
    const sch = createScheduler({ enableFuzz: false })
    const withoutPractice = sch.replay(
      card,
      w.reviews.forCard(card).filter((e) => e.id !== p),
    )
    expect(sch.replay(card, w.reviews.forCard(card))).toEqual(withoutPractice)
    expect(withoutPractice.reps).toBe(2)
    // Voided reviews leave the session too.
    w.reviews.void(p)
    expect(w.reviews.forSession(cram)).toEqual([])
    expect(w.reviews.all().map((e) => e.id)).toEqual([old, r])
    // recordMany carries them too.
    const [m] = w.reviews.recordMany([{ cardId: card, rating: 2, at: NOW + 2 * MIN, ms: 1, sid: cram, p: true }])
    expect(w.reviews.forSession(cram).map((e) => e.id)).toEqual([m as Id])
  })

  test('two devices reviewing the same card in different sessions converge to one schedule', () => {
    const a = make(7)
    const b = make(8)
    const { cards } = deck(a.w, 1)
    const card = cards[0] as Id
    a.w.reviews.record({ cardId: card, rating: 3, at: NOW - 5 * DAY_MS, ms: 1 })
    sync(a.doc, b.doc)
    // Offline: a crams the card, b reviews it for real, at overlapping times.
    const sa = a.w.sessions.start({ scope: {}, kind: 'all', practice: true })
    const sb = b.w.sessions.start({ scope: {}, kind: 'due', practice: false })
    const grades: [ModelWorkspace, Id, boolean, Rating, number][] = [
      [a.w, sa, true, 1, NOW + MIN],
      [b.w, sb, false, 4, NOW + 2 * MIN],
      [a.w, sa, true, 2, NOW + 3 * MIN],
      [b.w, sb, false, 1, NOW + 3 * MIN],
    ]
    for (const [w, id, practice, rating, at] of grades)
      w.reviews.record(sessionReview({ id, practice }, { cardId: card, rating, at, ms: 900 }))
    a.w.sessions.end(sa)
    b.w.sessions.end(sb)
    sync(a.doc, b.doc)
    expect(canonicalJson(a.doc)).toBe(canonicalJson(b.doc))
    const sch = createScheduler()
    const sa1 = sch.replay(card, a.w.reviews.forCard(card))
    expect(sa1).toEqual(createScheduler().replay(card, b.w.reviews.forCard(card)))
    // The schedule is b's alone: the same as if a had never crammed.
    const solo = make(9)
    const { cards: soloCards } = deck(solo.w, 1)
    const only = soloCards[0] as Id
    solo.w.reviews.record({ cardId: only, rating: 3, at: NOW - 5 * DAY_MS, ms: 1 })
    solo.w.reviews.record({ cardId: only, rating: 4, at: NOW + 2 * MIN, ms: 900 })
    solo.w.reviews.record({ cardId: only, rating: 1, at: NOW + 3 * MIN, ms: 900 })
    const soloState = createScheduler().replay(only, solo.w.reviews.forCard(only))
    expect({ ...sa1, cardId: only, history: sa1.history.map((h) => ({ ...h, reviewId: '' })) }).toEqual({
      ...soloState,
      history: soloState.history.map((h) => ({ ...h, reviewId: '' })),
    })
    // Both sessions summarise the same everywhere.
    expect(sessionHistory(a.w)).toEqual(sessionHistory(b.w))
    const byId = new Map(sessionHistory(a.w).map((s) => [s.session.id, s]))
    expect(byId.get(sa)).toMatchObject({ reviews: 2, cards: 1, failed: [card], grades: { 1: 1, 2: 1, 3: 0, 4: 0 } })
    expect(byId.get(sb)).toMatchObject({ reviews: 2, cards: 1, failed: [card], grades: { 1: 1, 2: 0, 3: 0, 4: 1 } })
  })
})

describe('history', () => {
  test('a summary: duration, distinct cards, grades, failed cards in order, answer time', () => {
    const session = { id: 's', startedAt: NOW, scope: {}, kind: 'due' as const, practice: false }
    const r = (id: string, cardId: string, rating: Rating, at: number, ms = 1000) => ({
      id,
      cardId,
      rating,
      at,
      ms,
      dev: 'd',
      sid: 's',
    })
    const reviews = [r('3', 'b', 1, NOW + 3 * MIN), r('1', 'a', 1, NOW + MIN, -4), r('2', 'a', 3, NOW + 2 * MIN)]
    expect(summarize(session, reviews)).toEqual({
      session,
      durationMs: 3 * MIN,
      reviews: 3,
      cards: 2,
      grades: { 1: 2, 2: 0, 3: 1, 4: 0 },
      failed: ['a', 'b'],
      answerMs: 2000,
    })
    expect(summarize({ ...session, endedAt: NOW + 10 * MIN }, reviews).durationMs).toBe(10 * MIN)
    expect(summarize(session, [])).toMatchObject({ durationMs: 0, reviews: 0, cards: 0, failed: [] })
  })

  test('relaunching the failed cards starts a failed session over them, same scope and mode', () => {
    const { w, clock } = make(10)
    const { course, cards } = deck(w, 3)
    const [c1, c2, c3] = cards as [Id, Id, Id]
    const s = w.sessions.start({ scope: { courseId: course }, kind: 'new', practice: true })
    const rec = (cardId: Id, rating: Rating) => {
      clock.advance(MIN)
      w.reviews.record(sessionReview({ id: s, practice: true }, { cardId, rating, at: clock.now(), ms: 1 }))
    }
    rec(c2, 1)
    rec(c1, 3)
    rec(c3, 1)
    rec(c2, 3)
    w.sessions.end(s)
    const again = relaunchFailed(w, s)
    expect(again).not.toBeNull()
    expect(w.sessions.get(again as Id)).toMatchObject({
      kind: 'failed',
      scope: { courseId: course },
      practice: true,
      cardIds: [c2, c3],
    })
    const q = sessionQueue(w, { kind: 'failed', cardIds: [c2, c3], now: clock.now(), practice: true, tzOffsetMin: 0 })
    expect(q.map((e) => e.cardId)).toEqual([c2, c3])
    // Nothing failed: nothing to relaunch, nothing written.
    const clean = w.sessions.start({ scope: {}, kind: 'due', practice: false })
    const n = events(w).length
    expect(relaunchFailed(w, clean)).toBeNull()
    expect(events(w).length).toBe(n)
    expect(() => relaunchFailed(w, 'nope')).toThrow(EntityNotFoundError)
    expect(sessionHistory(w).map((h) => h.session.id)).toEqual([clean, again as Id, s])
  })
})

describe('session queue over the workspace', () => {
  test('trash (direct, a trashed course, a trashed subset above) and suspension keep cards out', () => {
    const { w } = make(11)
    const { course, cards } = deck(w, 6)
    const [keep, trashed, suspended, inBin, deeper, filed] = cards as [Id, Id, Id, Id, Id, Id]
    const ch = w.sections.create({ courseId: course, name: 'Ch' })
    const sub = w.sections.create({ courseId: course, parentId: ch, name: 'Sub' })
    const other = w.sections.create({ courseId: course, name: 'Other' })
    w.moveItem('cards', inBin, ch)
    w.moveItem('cards', deeper, sub)
    w.moveItem('cards', filed, other)
    w.cards.trash(trashed)
    w.cards.update(suspended, { suspended: true })
    const q = (scope?: { courseId?: Id; sectionId?: Id }) =>
      sessionQueue(w, { kind: 'new', now: NOW, practice: true, tzOffsetMin: 0, ...(scope ? { scope } : {}) }).map(
        (e) => e.cardId,
      )
    expect(q()).toEqual([keep, inBin, deeper, filed].sort())
    expect(q({ courseId: course, sectionId: ch })).toEqual([inBin, deeper].sort())
    expect(q({ sectionId: sub })).toEqual([deeper])
    // Trashing the chapter hides everything below it, without touching the cards.
    w.sections.trash(ch)
    expect(q()).toEqual([keep, filed].sort())
    expect(q({ sectionId: sub })).toEqual([])
    expect(w.cards.get(deeper)?.deletedAt).toBeUndefined()
    // A trashed course: nothing.
    w.courses.trash(course)
    expect(q()).toEqual([])
  })

  test('kinds over real reviews; practice reviews neither move the schedule nor use the new-card budget', () => {
    const { w } = make(12)
    w.prefs.set('dailyNewCards', 1)
    const { cards } = deck(w, 4)
    const [seen, crammed, n1, n2] = cards as [Id, Id, Id, Id]
    w.reviews.record({ cardId: seen, rating: 3, at: NOW - 30 * DAY_MS, ms: 1 })
    w.reviews.record({ cardId: seen, rating: 3, at: NOW - 20 * DAY_MS, ms: 1 })
    const cram = w.sessions.start({ scope: {}, kind: 'new', practice: true })
    w.reviews.record(sessionReview({ id: cram, practice: true }, { cardId: crammed, rating: 1, at: NOW - MIN, ms: 1 }))
    const q = (kind: 'due' | 'ahead' | 'failed' | 'new' | 'all', practice = false) =>
      sessionQueue(w, { kind, now: NOW, practice, tzOffsetMin: 0 }).map((e) => e.cardId)
    const newOnes = [crammed, n1, n2].sort()
    // The crammed card is still new, and today's budget (1) is untouched by the practice review.
    expect(q('new')).toEqual(newOnes.slice(0, 1))
    expect(q('new', true)).toEqual(newOnes)
    expect(q('failed', true)).toEqual([crammed])
    // Counting in the schedule, the crammed card (new for it) takes the day's one new-card slot.
    expect(q('failed')).toEqual([crammed])
    expect(sessionQueue(w, { kind: 'ahead', now: NOW, days: 365, tzOffsetMin: 0 }).map((e) => e.cardId)).toEqual([seen])
    // Due: never a new card, crammed or not.
    expect(q('due').every((id) => id === seen)).toBe(true)
    expect(q('all', true)).toEqual([seen, ...newOnes])
    expect(sessionQueue(w, { kind: 'all', now: NOW, practice: true, limit: 2 }).length).toBe(2)
  })
})

const plan: PlanInput = { name: 'Contracts', kind: 'due', weekdays: [5, 1, 3, 1], time: '18:30', practice: false }

describe('planned sessions', () => {
  test('a collection of maps of scalars, checked on every write', () => {
    const { w, doc } = make(13)
    const id = w.plans.create({ ...plan, courseId: 'law', limit: 20 })
    expect(w.plans.get(id)).toMatchObject({ ...plan, weekdays: [1, 3, 5], courseId: 'law', limit: 20 })
    const m = doc.getMap<Y.Map<unknown>>(ROOT.plans).get(id)
    expect(m?.get('weekdays')).toEqual([1, 3, 5])
    expect(w.plans.list({ courseId: 'law' }).map((p) => p.id)).toEqual([id])
    w.plans.update(id, { weekdays: [7, 6], name: 'Weekend' })
    expect(w.plans.get(id)).toMatchObject({ name: 'Weekend', weekdays: [6, 7] })
    w.plans.update(id, { limit: undefined })
    expect(w.plans.get(id)?.limit).toBeUndefined()
    expect(() => w.plans.update(id, { time: '25:00' })).toThrow(SessionInputError)
    expect(() => w.plans.update(id, { name: undefined })).toThrow(SessionInputError)
    expect(() => w.plans.update(id, { weekdays: [] })).toThrow(SessionInputError)
    expect(() => w.plans.update('nope', { name: 'x' })).toThrow(EntityNotFoundError)
    for (const bad of [
      { name: ' ' },
      { kind: 'x' as 'due' },
      { limit: 0 },
      { time: '7:00' },
      { weekdays: [] },
      { weekdays: [0] as never },
      { weekdays: [8] as never },
      { practice: undefined as never },
    ])
      expect(() => w.plans.create({ ...plan, ...bad })).toThrow(SessionInputError)
    expect(w.plans.list().length).toBe(1)
    w.plans.trash(id)
    expect(w.plans.list()).toEqual([])
    w.plans.restore(id)
    const rec = w.plans.get(id)
    if (!rec) throw new Error('plan lost')
    expect(planScope(rec)).toEqual({ courseId: 'law' })
    expect(planScope({ sectionId: 's' })).toEqual({ sectionId: 's' })
    expect(planSession(rec)).toEqual({ scope: { courseId: 'law' }, kind: 'due', practice: false, planId: id })
    w.plans.update(id, { limit: 5 })
    const started = w.sessions.start(planSession(w.plans.get(id) ?? rec))
    expect(w.sessions.get(started)).toMatchObject({ planId: id, limit: 5 })
  })

  test('next occurrence: next listed weekday at the local time, following the zone', () => {
    const utc = () => 0
    const p = { weekdays: [1, 3, 5] as PlanInput['weekdays'], time: '18:30' }
    // Wednesday 10:00 UTC: today 18:30.
    expect(nextOccurrence(p, NOW, utc)).toBe(Date.UTC(2026, 9, 14, 18, 30))
    expect(nextOccurrence(p, Date.UTC(2026, 9, 14, 18, 30), utc)).toBe(Date.UTC(2026, 9, 14, 18, 30))
    // Past it: Friday.
    expect(nextOccurrence(p, Date.UTC(2026, 9, 14, 19, 0), utc)).toBe(Date.UTC(2026, 9, 16, 18, 30))
    // Only Wednesdays, just after: a week later.
    expect(nextOccurrence({ ...p, weekdays: [3] }, Date.UTC(2026, 9, 14, 18, 31), utc)).toBe(
      Date.UTC(2026, 9, 21, 18, 30),
    )
    // Two hours east of UTC: 18:30 local is 16:30 UTC.
    expect(nextOccurrence(p, NOW, () => 120)).toBe(Date.UTC(2026, 9, 14, 16, 30))
    // Late on Tuesday in UTC is already Wednesday in Tokyo (+9).
    expect(nextOccurrence({ ...p, weekdays: [3], time: '08:00' }, Date.UTC(2026, 9, 13, 20, 0), () => 540)).toBe(
      Date.UTC(2026, 9, 14, 23, 0) - DAY_MS,
    )
    // Daylight saving time ends on Sunday 2026-10-25 in Paris (+120 → +60): Monday's 18:30 is 17:30 UTC.
    const paris = (at: number) => (at < Date.UTC(2026, 9, 25, 1) ? 120 : 60)
    expect(nextOccurrence({ ...p, weekdays: [1] }, Date.UTC(2026, 9, 23, 12), paris)).toBe(
      Date.UTC(2026, 9, 26, 17, 30),
    )
    expect(nextOccurrence({ ...p, deletedAt: 1 }, NOW, utc)).toBeNull()
    expect(nextOccurrence({ ...p, weekdays: [] }, NOW, utc)).toBeNull()
    expect(nextOccurrence({ ...p, weekdays: [9] as never }, NOW, utc)).toBeNull()
    expect(typeof nextOccurrence(p, NOW)).toBe('number')
    expect(() => nextOccurrence({ ...p, time: 'noon' }, NOW, utc)).toThrow(SessionInputError)
    expect(parseTime('07:05')).toEqual({ hour: 7, minute: 5 })
  })

  test('the next planned session among live plans', () => {
    const { w } = make(14)
    expect(nextPlanned(w.plans.list(), NOW)).toBeNull()
    const fri = w.plans.create({ ...plan, name: 'Fri', weekdays: [5] })
    const thu = w.plans.create({ ...plan, name: 'Thu', weekdays: [4] })
    const thursday = w.plans.get(thu) as PlanRecord
    expect(nextPlanned(w.plans.list(), NOW, () => 0)).toEqual({ plan: thursday, at: Date.UTC(2026, 9, 15, 18, 30) })
    w.plans.trash(thu)
    expect(nextPlanned(w.plans.list(), NOW, () => 0)?.plan.id).toBe(fri)
    expect(nextPlanned([{ ...thursday, deletedAt: 1 }], NOW, () => 0)).toBeNull()
  })
})

describe('the workspace and sessions', () => {
  test('creating the workspace and every read write nothing', () => {
    const { w, doc } = make(15)
    const sv = Y.encodeStateVector(doc)
    w.sessions.list()
    w.sessions.get('x')
    w.plans.list()
    sessionHistory(w)
    sessionQueue(w, { kind: 'all', now: NOW })
    nextPlanned(w.plans.list(), NOW)
    expect(Buffer.from(Y.encodeStateVector(doc)).equals(Buffer.from(sv))).toBe(true)
    expect(doc.share.size).toBeGreaterThan(0)
    expect(canonicalJson(doc)).toBe('{}')
  })

  test('subscribing to sessions and plans; atomic undoes a session start', () => {
    const { w } = make(16)
    let s = 0
    let p = 0
    const offS = w.subscribe('sessions', () => s++)
    const offP = w.subscribe('plans', () => p++)
    w.sessions.start({ scope: {}, kind: 'due', practice: false })
    w.plans.create(plan)
    expect([s, p]).toEqual([1, 1])
    offS()
    offP()
    w.sessions.start({ scope: {}, kind: 'due', practice: false })
    expect(s).toBe(1)
    expect(() =>
      w.atomic(() => {
        w.sessions.start({ scope: {}, kind: 'new', practice: true })
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(w.sessions.list().map((x) => x.kind)).toEqual(['due', 'due'])
  })
})
