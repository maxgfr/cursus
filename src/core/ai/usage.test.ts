import { describe, expect, test } from 'bun:test'
import { costOf } from './cost'
import { INFO } from './testkit.test'
import { type AiUsageEvent, monthCost, usageEvent } from './usage'

describe('cost and usage', () => {
  test('cost is per million tokens; unpriced is free', () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 500_000 }, { input: 2, output: 10 })).toBe(7)
    expect(costOf({ inputTokens: 5, outputTokens: 5 }, undefined)).toBe(0)
  })

  test('usageEvent prices the call from the catalog model', () => {
    const e = usageEvent('quiz', INFO, { inputTokens: 1000, outputTokens: 100 }, 42)
    expect(e).toEqual({
      at: 42,
      feature: 'quiz',
      provider: 'mockai',
      model: 'mock-1',
      inputTokens: 1000,
      outputTokens: 100,
      cost: 0.003,
    })
  })

  test('monthCost sums only the current local month', () => {
    const at = (y: number, m: number, d: number) => new Date(y, m, d, 12).getTime()
    const ev = (t: number, cost: number): AiUsageEvent => ({
      ...usageEvent('quiz', INFO, { inputTokens: 0, outputTokens: 0 }, t),
      cost,
    })
    const events = [ev(at(2026, 9, 1), 1), ev(at(2026, 9, 31), 2), ev(at(2026, 8, 30), 4), ev(at(2026, 10, 1), 8)]
    expect(monthCost(events, at(2026, 9, 14))).toBe(3)
    expect(monthCost([], at(2026, 9, 14))).toBe(0)
  })
})
