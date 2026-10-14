import { expect, test } from 'bun:test'
import type { Rating, Review } from '../contracts/workspace'
import { createScheduler, DAY_MS } from './fsrs'
import { buildQueue } from './queue'
import { forecast } from './stats'

/**
 * Budget: 10 000 cards and 200 000 reviews replayed, queued and forecast in
 * under 15 s. Locally this takes well under 2 s; the bound is generous to
 * absorb slow CI runners while still catching an accidental O(n²) replay.
 */
const BUDGET_MS = 15_000

test('10k cards / 200k reviews within budget', () => {
  const CARDS = 10_000
  const PER_CARD = 20
  const log: Review[] = []
  let seed = 42
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed
  }
  const t0 = Date.UTC(2025, 0, 1)
  for (let c = 0; c < CARDS; c++) {
    let t = t0 + (next() % 1000) * 60_000
    for (let r = 0; r < PER_CARD; r++) {
      t += (next() % 15) * DAY_MS + 60_000
      log.push({ id: `${c}-${r}`, cardId: `card${c}`, rating: ((next() % 4) + 1) as Rating, at: t, ms: 2000, dev: 'd' })
    }
  }
  expect(log.length).toBe(200_000)
  const start = performance.now()
  const states = createScheduler().replayAll(log)
  const now = t0 + 400 * DAY_MS
  const cards = Array.from({ length: CARDS }, (_, i) => ({ id: `card${i}` }))
  const q = buildQueue({ cards, states, now, tzOffsetMin: 0, newPerDay: 20 })
  forecast(states.values(), now, 0)
  const elapsed = performance.now() - start
  expect(states.size).toBe(CARDS)
  expect(q.length).toBeGreaterThan(0)
  expect(elapsed).toBeLessThan(BUDGET_MS)
}, 60_000)
