import { type CardState, dayStart, studyDay } from './fsrs'

export interface DayActivity {
  day: number
  reviews: number
  ms: number
}

/** Reviews and time spent per study day, ascending. */
export function activity(reviews: readonly { at: number; ms: number }[], tzOffsetMin: number): DayActivity[] {
  const map = new Map<number, DayActivity>()
  for (const r of reviews) {
    const day = studyDay(r.at, tzOffsetMin)
    const a = map.get(day) ?? { day, reviews: 0, ms: 0 }
    a.reviews++
    a.ms += Math.max(0, r.ms)
    map.set(day, a)
  }
  return [...map.values()].sort((a, b) => a.day - b.day)
}

export interface Retention {
  passed: number
  total: number
  /** passed / total, or null when no mature review happened. */
  rate: number | null
}

/**
 * True retention: share of reviews of cards in the review phase (not
 * learning) answered Hard or better, within [from, to).
 */
export function trueRetention(states: Iterable<CardState>, from: number, to: number): Retention {
  let passed = 0
  let total = 0
  for (const s of states) {
    for (const h of s.history) {
      if (h.phaseBefore !== 'review' || h.at < from || h.at >= to) continue
      total++
      if (h.rating > 1) passed++
    }
  }
  return { passed, total, rate: total === 0 ? null : passed / total }
}

export interface ForecastDay {
  day: number
  due: number
}

/** Cards falling due on each of the next `days` study days (overdue counted today). */
export function forecast(states: Iterable<CardState>, now: number, tzOffsetMin: number, days = 7): ForecastDay[] {
  const today = studyDay(now, tzOffsetMin)
  const out: ForecastDay[] = Array.from({ length: days }, (_, i) => ({ day: today + i, due: 0 }))
  const horizon = dayStart(today + days, tzOffsetMin)
  for (const s of states) {
    if (s.phase === 'new' || s.due >= horizon) continue
    const i = Math.max(0, studyDay(s.due, tzOffsetMin) - today)
    ;(out[i] as ForecastDay).due++
  }
  return out
}

export function countByPhase(states: Iterable<CardState>): Record<CardState['phase'], number> {
  const out = { new: 0, learning: 0, review: 0, relearning: 0 }
  for (const s of states) out[s.phase]++
  return out
}
