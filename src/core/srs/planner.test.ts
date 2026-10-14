import { describe, expect, test } from 'bun:test'
import { DAY_MS, DEFAULT_PARAMS, dayStart, newCardState } from './fsrs'
import { dailyGoal, daysUntil, EXAM_RETENTION, paramsFor } from './planner'

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
