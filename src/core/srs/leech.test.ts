import { expect, test } from 'bun:test'
import type { Rating, Review } from '../contracts/workspace'
import { createScheduler, DAY_MS } from './fsrs'
import { isLeech, LEECH_LAPSES, leeches } from './leech'

const rv = (id: string, cardId: string, rating: Rating, at: number): Review => ({
  id,
  cardId,
  rating,
  at,
  ms: 1,
  dev: 'd',
})

test('a card becomes a leech after 8 lapses', () => {
  const log: Review[] = []
  let t = 0
  log.push(rv('000', 'c', 4, t))
  for (let i = 0; i < LEECH_LAPSES; i++) {
    t += 10 * DAY_MS
    log.push(rv(`a${i}`, 'c', 1, t))
    t += DAY_MS
    log.push(rv(`b${i}`, 'c', 4, t))
  }
  const sch = createScheduler()
  const seven = sch.replay('c', log.slice(0, -2))
  const eight = sch.replay('c', log)
  expect(seven.lapses).toBe(7)
  expect(isLeech(seven)).toBe(false)
  expect(eight.lapses).toBe(8)
  expect(isLeech(eight)).toBe(true)
  expect(leeches([eight, { ...seven, cardId: 'z' }, { ...eight, cardId: 'a' }])).toEqual(['a', 'c'])
})
