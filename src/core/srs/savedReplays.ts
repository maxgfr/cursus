import type { LocalStore } from '../contracts/ports'
import type { ReplaySnapshot } from './fsrs'

/**
 * Replaying 200,000 reviews is most of a cold launch. The scheduler's replay cache is kept in this device's kv
 * under this key and seeds the next launch; each entry is used only when its fingerprint still matches.
 */
export const REPLAYS_KEY = 'srs.replays'

/**
 * How long a launch waits for the saved replays, counted from when the read starts (alongside the library's).
 * Past it, replaying everything (about 650 ms for 200,000 reviews on a phone) is cheaper than waiting longer.
 */
export const REPLAYS_WAIT_MS = 1_000

/**
 * Reads the replays an earlier launch saved. Never rejects and never waits longer than `waitMs`: a snapshot
 * that cannot be read, or not in time, is logged and the first computation replays everything instead.
 */
export function readSavedReplays(
  store: Pick<LocalStore, 'read'>,
  waitMs: number = REPLAYS_WAIT_MS,
): Promise<ReplaySnapshot | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`saved replays not read within ${waitMs} ms: replaying every review`)
      resolve(null)
    }, waitMs)
    store
      .read(['kv'], (tx) => tx.get<ReplaySnapshot>('kv', REPLAYS_KEY))
      .then(
        (s) => resolve(s ?? null),
        (e: unknown) => {
          console.error('saved replays unavailable', e)
          resolve(null)
        },
      )
      .finally(() => clearTimeout(timer))
  })
}
