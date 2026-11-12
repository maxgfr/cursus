import type { Clock, Rng } from '../contracts/ports'
import { systemClock } from './clock'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeTime(ms: number): string {
  let out = ''
  let t = Math.floor(ms)
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD.charAt(t % 32) + out
    t = Math.floor(t / 32)
  }
  return out
}

function ulid(clock: Clock, u32: () => number): string {
  let rand = ''
  for (let i = 0; i < 16; i++) rand += CROCKFORD.charAt(u32() % 32)
  return encodeTime(clock.now()) + rand
}

/** The random part plus one, in Crockford base 32; null when it is all `Z` (nothing above it). */
function increment(rand: string): string | null {
  const digits = rand.split('')
  for (let i = digits.length - 1; i >= 0; i--) {
    const v = CROCKFORD.indexOf(digits[i] as string)
    if (v < 31) {
      digits[i] = CROCKFORD.charAt(v + 1)
      return digits.join('')
    }
    digits[i] = '0'
  }
  return null
}

/**
 * Monotonic ULIDs (the ULID spec's monotonic factory): the first id of a millisecond is random, the next ones in
 * the same millisecond add one to it, so things created together (an import, accepted cards) keep the order they
 * were created in, as everything is listed by id.
 */
function monotonic(clock: Clock, u32: () => number): () => string {
  let last = ''
  return () => {
    const next = ulid(clock, u32)
    if (last !== '' && next.slice(0, 10) <= last.slice(0, 10)) {
      const rand = increment(last.slice(10))
      if (rand !== null) {
        last = last.slice(0, 10) + rand
        return last
      }
    }
    last = next
    return next
  }
}

/** Production RNG backed by crypto.getRandomValues; ids are monotonic ULIDs. */
export function cryptoRng(clock: Clock = systemClock): Rng {
  const buf = new Uint32Array(1)
  const u32 = () => {
    crypto.getRandomValues(buf)
    return buf[0] ?? 0
  }
  return { u32, id: monotonic(clock, u32) }
}

/** Deterministic RNG (mulberry32) for tests. */
export function seededRng(seed: number, clock: Clock = { now: () => 0 }): Rng {
  let s = seed >>> 0
  const u32 = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 15), z | 1)
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
    return (z ^ (z >>> 14)) >>> 0
  }
  return { u32, id: () => ulid(clock, u32) }
}
