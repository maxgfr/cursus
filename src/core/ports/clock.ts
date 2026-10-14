import type { Clock } from '../contracts/ports'

export const systemClock: Clock = { now: () => Date.now() }

export interface VirtualClock extends Clock {
  advance(ms: number): number
  set(ms: number): void
}

export function virtualClock(start = 0): VirtualClock {
  let t = start
  return {
    now: () => t,
    advance(ms) {
      if (ms < 0) throw new RangeError('VirtualClock cannot go backwards')
      t += ms
      return t
    },
    set(ms) {
      t = ms
    },
  }
}
