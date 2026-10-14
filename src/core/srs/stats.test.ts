import { expect, test } from 'bun:test'
import type { Rating, Review } from '../contracts/workspace'
import { createScheduler, DAY_MS, dayStart, newCardState } from './fsrs'
import { activity, countByPhase, forecast, trueRetention } from './stats'

const TZ = 0
const D0 = dayStart(20_500, TZ)
const rv = (
  id: string,
  cardId: string,
  rating: Rating,
  at: number,
  ms = 1000,
): Review & { ms: number; at: number } => ({
  id,
  cardId,
  rating,
  at,
  ms,
  dev: 'd',
})

test('activity groups reviews per study day', () => {
  const a = activity([rv('1', 'c', 3, D0 + 10), rv('2', 'c', 3, D0 + DAY_MS - 1, -5), rv('3', 'c', 3, D0 + DAY_MS)], TZ)
  expect(a).toEqual([
    { day: 20_500, reviews: 2, ms: 1000 },
    { day: 20_501, reviews: 1, ms: 1000 },
  ])
})

test('true retention only counts review-phase answers in range', () => {
  const log: Review[] = [
    rv('a', 'c', 4, D0),
    rv('b', 'c', 3, D0 + 20 * DAY_MS),
    rv('c', 'c', 1, D0 + 60 * DAY_MS),
    rv('d', 'c', 3, D0 + 60 * DAY_MS + 600_000),
  ]
  const states = [...createScheduler().replayAll(log).values()]
  expect(trueRetention(states, D0, D0 + 100 * DAY_MS)).toEqual({ passed: 1, total: 2, rate: 0.5 })
  expect(trueRetention(states, D0, D0 + 30 * DAY_MS)).toEqual({ passed: 1, total: 1, rate: 1 })
  expect(trueRetention(states, 0, 1).rate).toBeNull()
})

test('forecast counts due cards over the next 7 days, overdue today', () => {
  const now = D0 + 3_600_000
  const at = (due: number) => ({ ...newCardState(`x${due}`), phase: 'review' as const, due })
  const f = forecast([at(D0 - 5 * DAY_MS), at(D0 + 2 * DAY_MS + 5), at(D0 + 9 * DAY_MS), newCardState('n')], now, TZ)
  expect(f.length).toBe(7)
  expect(f.map((d) => d.due)).toEqual([1, 0, 1, 0, 0, 0, 0])
  expect(countByPhase([at(1), newCardState('n')])).toEqual({ new: 1, learning: 0, review: 1, relearning: 0 })
})
