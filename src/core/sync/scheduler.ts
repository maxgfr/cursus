import { RemoteError } from '../contracts/errors'
import type { Clock, Rng } from '../contracts/ports'
import type { Scheduler } from '../contracts/sync'
import type { VirtualClock } from '../ports/clock'
import type { RoundResult } from './engine'

export type Trigger = Parameters<Scheduler['trigger']>[0]

/** Timer port: real setTimeout in the app, virtual timers in tests (no real timer ever runs there). */
export interface Timers {
  set(fn: () => void, ms: number): () => void
}

export const browserTimers: Timers = {
  set(fn, ms) {
    const h = setTimeout(fn, ms)
    return () => clearTimeout(h)
  },
}

export interface VirtualTimers extends Timers {
  /** Moves the clock forward, firing due timers in order. */
  advance(ms: number): void
  pending(): number
}

export function virtualTimers(clock: VirtualClock): VirtualTimers {
  let seq = 0
  const queue: { at: number; seq: number; fn: () => void }[] = []
  return {
    set(fn, ms) {
      const t = { at: clock.now() + Math.max(0, ms), seq: seq++, fn }
      queue.push(t)
      return () => {
        const i = queue.indexOf(t)
        if (i >= 0) queue.splice(i, 1)
      }
    },
    advance(ms) {
      const end = clock.now() + ms
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
        const next = queue[0]
        if (!next || next.at > end) break
        queue.shift()
        if (next.at > clock.now()) clock.set(next.at)
        next.fn()
      }
      if (end > clock.now()) clock.set(end)
    },
    pending: () => queue.length,
  }
}

export const BACKOFF_BASE_MS = 1000
export const BACKOFF_MAX_MS = 5 * 60 * 1000
export const VISIBLE_INTERVAL_MS = 60 * 1000
/** Seal, back-visible and timer triggers this close together make one round. */
export const DEBOUNCE_MS = 2000

/** n-th consecutive failure ⇒ delay in [base/2, base] with base = min(max, 1 s · 2^(n−1)), never below Retry-After. */
export function backoffDelay(failures: number, rng: Rng, retryAfterMs?: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))
  const jittered = Math.round(base / 2 + (rng.u32() / 2 ** 32) * (base / 2))
  return Math.max(jittered, retryAfterMs ?? 0)
}

export interface SchedulerOptions {
  engine: {
    round(dest: string): Promise<RoundResult>
    destIds(): string[]
    noteSchedule(dest: string, nextTryAt: number | undefined): void
  }
  clock: Clock
  rng: Rng
  timers: Timers
  isVisible?: () => boolean
  isOnline?: () => boolean
  /** Every failure is reported here (the engine already put it in the destination status). */
  onError?: (dest: string, e: unknown) => void
}

export interface SyncScheduler extends Scheduler {
  /** Resolves once no round is running or queued to run immediately. */
  whenIdle(): Promise<void>
  failures(dest: string): number
}

interface PerDest {
  running: Promise<void> | null
  again: boolean
  failures: number
  nextTryAt?: number
  cancel?: () => void
  /** When the last successful round started. */
  okStartedAt?: number
}

/** Triggers that wait a moment so that a burst of them makes one round. */
const DEBOUNCED: ReadonlySet<Trigger> = new Set<Trigger>(['sealed', 'visible', 'timer'])

/**
 * Triggers: startup, seal, back online, back visible, every 60 s while visible, manual.
 * Seal, visible and timer are debounced together (2 s); a timer round is skipped when a round succeeded
 * less than 60 s before. One round at a time per destination (a trigger during a round queues exactly
 * one more). Failures back off per destination, 1 s → 5 min with jitter, honouring Retry-After; a
 * manual trigger bypasses the backoff.
 */
export function createScheduler(o: SchedulerOptions): SyncScheduler {
  const per = new Map<string, PerDest>()
  let started = false
  let cancelTick: (() => void) | null = null
  let cancelDebounce: (() => void) | null = null
  /** The debounced burst holds only timer triggers so far. */
  let timerOnly = true
  const visible = (): boolean => o.isVisible?.() ?? true
  const online = (): boolean => o.isOnline?.() ?? true

  const state = (dest: string): PerDest => {
    let s = per.get(dest)
    if (!s) {
      s = { running: null, again: false, failures: 0 }
      per.set(dest, s)
    }
    return s
  }

  const retryLater = (dest: string, s: PerDest, retryAfterMs?: number): void => {
    s.failures++
    const delay = backoffDelay(s.failures, o.rng, retryAfterMs)
    s.nextTryAt = o.clock.now() + delay
    s.cancel?.()
    s.cancel = o.timers.set(() => {
      s.cancel = undefined
      if (started) run(dest)
    }, delay)
    o.engine.noteSchedule(dest, s.nextTryAt)
  }

  const run = (dest: string): void => {
    const s = state(dest)
    if (s.running) {
      s.again = true
      return
    }
    s.running = (async () => {
      const startedAt = o.clock.now()
      try {
        const r = await o.engine.round(dest)
        if (r.deferred > 0) retryLater(dest, s)
        else {
          s.okStartedAt = startedAt
          s.failures = 0
          s.nextTryAt = undefined
          s.cancel?.()
          s.cancel = undefined
          o.engine.noteSchedule(dest, undefined)
        }
      } catch (e) {
        o.onError?.(dest, e)
        retryLater(dest, s, e instanceof RemoteError ? e.retryAfterMs : undefined)
      } finally {
        s.running = null
        if (s.again && started) {
          s.again = false
          run(dest)
        }
      }
    })()
  }

  const fire = (r: Trigger): void => {
    const now = o.clock.now()
    for (const dest of o.engine.destIds()) {
      const s = state(dest)
      if (r === 'manual') {
        s.failures = 0
        s.nextTryAt = undefined
        s.cancel?.()
        s.cancel = undefined
      } else if (s.nextTryAt !== undefined && now < s.nextTryAt) continue
      // The timer only keeps a quiet screen up to date: a round that just succeeded already did.
      if (r === 'timer' && s.okStartedAt !== undefined && now - s.okStartedAt < VISIBLE_INTERVAL_MS) continue
      run(dest)
    }
  }

  const tick = (): void => {
    cancelTick = o.timers.set(() => {
      if (!started) return
      if (visible()) self.trigger('timer')
      tick()
    }, VISIBLE_INTERVAL_MS)
  }

  const self: SyncScheduler = {
    start() {
      if (started) return
      started = true
      self.trigger('startup')
      tick()
    },
    stop() {
      started = false
      cancelTick?.()
      cancelTick = null
      cancelDebounce?.()
      cancelDebounce = null
      timerOnly = true
      for (const s of per.values()) {
        s.cancel?.()
        s.cancel = undefined
        s.again = false
      }
    },
    trigger(r) {
      if (!started) return
      if (r !== 'manual' && !online()) return
      if (DEBOUNCED.has(r)) {
        if (r !== 'timer') timerOnly = false
        cancelDebounce ??= o.timers.set(() => {
          cancelDebounce = null
          const reason: Trigger = timerOnly ? 'timer' : 'sealed'
          timerOnly = true
          if (started && online()) fire(reason)
        }, DEBOUNCE_MS)
        return
      }
      fire(r)
    },
    async whenIdle() {
      for (;;) {
        const running = [...per.values()].map((s) => s.running).filter((p): p is Promise<void> => p !== null)
        if (running.length === 0) return
        await Promise.all(running)
      }
    },
    failures: (dest) => per.get(dest)?.failures ?? 0,
  }
  return self
}
