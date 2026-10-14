import { describe, expect, test } from 'bun:test'
import { DAY_MS, DEFAULT_PARAMS, dayStart, newCardState } from './fsrs'
import {
  courseDeadline,
  dailyGoal,
  daysUntil,
  EXAM_RETENTION,
  examFor,
  nearestExam,
  nearestScopedExam,
  paramsFor,
  type ScopedExam,
  scopedDailyGoal,
} from './planner'
import type { QueueCard } from './queue'

const TZ = 60
const D = (n: number): number => dayStart(20_000 + n, TZ) + 3_600_000

describe('planner', () => {
  const plan = { examAt: D(30), tzOffsetMin: TZ }

  test('daysUntil counts study days and floors at 0', () => {
    expect(daysUntil(plan, D(0))).toBe(30)
    expect(daysUntil(plan, D(31))).toBe(0)
  })

  test('retention is 0.95 only during the last 7 days', () => {
    expect(paramsFor(DEFAULT_PARAMS, null, D(0))).toBe(DEFAULT_PARAMS)
    expect(paramsFor(DEFAULT_PARAMS, plan, D(22)).desiredRetention).toBe(DEFAULT_PARAMS.desiredRetention)
    expect(paramsFor(DEFAULT_PARAMS, plan, D(23)).desiredRetention).toBe(EXAM_RETENTION)
    expect(paramsFor(DEFAULT_PARAMS, plan, D(29)).desiredRetention).toBe(EXAM_RETENTION)
    expect(paramsFor(DEFAULT_PARAMS, plan, D(30)).desiredRetention).toBe(DEFAULT_PARAMS.desiredRetention)
    expect(paramsFor({ ...DEFAULT_PARAMS, desiredRetention: 0.97 }, plan, D(25)).desiredRetention).toBe(0.97)
  })

  test('daily goal spreads new cards before the final window and adds due cards', () => {
    const fresh = Array.from({ length: 46 }, (_, i) => newCardState(`n${i}`))
    const due = { ...newCardState('d'), phase: 'review' as const, due: D(0) }
    const notDue = { ...newCardState('e'), phase: 'review' as const, due: D(0) + 5 * DAY_MS }
    expect(dailyGoal(plan, [...fresh, due, notDue], D(0))).toEqual({ newCards: 2, dueCards: 1, total: 3 })
    expect(dailyGoal(plan, fresh, D(27)).newCards).toBe(16)
    expect(dailyGoal(plan, fresh, D(30)).newCards).toBe(46)
  })
})

describe('nearestExam', () => {
  const now = Date.UTC(2026, 5, 10, 12)
  const at = (days: number) => ({ examAt: now + days * DAY_MS, tzOffsetMin: 0 })
  test('picks the soonest exam ahead, today included, and skips past ones', () => {
    expect(nearestExam([], now)).toBeNull()
    expect(nearestExam([{ id: 'past', plan: at(-2) }], now)).toBeNull()
    expect(
      nearestExam(
        [
          { id: 'far', plan: at(20) },
          { id: 'past', plan: at(-1) },
          { id: 'near', plan: at(5) },
          { id: 'tie', plan: at(5) },
        ],
        now,
      ),
    ).toEqual({ id: 'near', days: 5 })
    expect(nearestExam([{ id: 'today', plan: at(0) }], now)).toEqual({ id: 'today', days: 0 })
  })
})

describe('exams per subset', () => {
  const now = Date.UTC(2026, 9, 14, 12)
  const plan = (days: number) => ({ examAt: now + days * DAY_MS, tzOffsetMin: 0 })
  const exams: ScopedExam[] = [
    { scope: { courseId: 'law' }, plan: plan(40) },
    { scope: { courseId: 'law', sectionId: 'contracts' }, plan: plan(5) },
    { scope: { courseId: 'law', sectionId: 'formation' }, plan: plan(-1) },
    { scope: { courseId: 'bio' }, plan: plan(3) },
  ]

  test('the nearest deadline among a course and its subsets; past exams ignored', () => {
    expect(nearestScopedExam([], now)).toBeNull()
    expect(nearestScopedExam(exams, now)).toEqual({ scope: { courseId: 'bio' }, plan: plan(3), days: 3 })
    expect(courseDeadline(exams, 'law', now)).toEqual({
      scope: { courseId: 'law', sectionId: 'contracts' },
      plan: plan(5),
      days: 5,
    })
    expect(courseDeadline(exams, 'chem', now)).toBeNull()
  })

  test("a card's exam is the nearest one covering it", () => {
    const deep: QueueCard = { id: 'd', courseId: 'law', sections: ['contracts', 'formation'] }
    const rootCard: QueueCard = { id: 'r', courseId: 'law' }
    expect(examFor(deep, exams, now)?.scope).toEqual({ courseId: 'law', sectionId: 'contracts' })
    expect(examFor(rootCard, exams, now)?.scope).toEqual({ courseId: 'law' })
    expect(examFor({ id: 'x', courseId: 'chem' }, exams, now)).toBeNull()
  })

  test('a chapter exam plans only the cards of that chapter', () => {
    const cards: QueueCard[] = [
      { id: 'in1', courseId: 'law', sections: ['contracts'] },
      { id: 'in2', courseId: 'law', sections: ['contracts', 'formation'] },
      { id: 'out', courseId: 'law', sections: ['torts'] },
      { id: 'root', courseId: 'law' },
    ]
    const reviewed = { ...newCardState('in2'), phase: 'review' as const, due: now }
    const chapter = exams[1] as ScopedExam
    const goal = scopedDailyGoal(chapter, cards, new Map([['in2', reviewed]]), now)
    expect(goal).toEqual({ newCards: 1, dueCards: 1, total: 2 })
    expect(scopedDailyGoal(exams[0] as ScopedExam, cards, new Map(), now).newCards).toBe(1)
  })
})
