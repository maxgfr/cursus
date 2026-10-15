import { expect, test } from 'bun:test'
import { IDLE_FALLBACK_MS, IDLE_TIMEOUT_MS, type IdleEnv, whenIdleOrSeen } from './whenIdleOrSeen.ts'

/** A hand-driven browser: idle callbacks, timers and one intersection observer, fired by the test. */
function fakeEnv(opts: { idle: boolean; observer: boolean }) {
  const idle = new Map<number, () => void>()
  const timers = new Map<number, { cb: () => void; ms: number }>()
  const idleOptions: ({ timeout: number } | undefined)[] = []
  let seen: ((entries: { isIntersecting: boolean }[]) => void) | null = null
  let observed: Element | null = null
  let disconnected = false
  let next = 1
  const env: IdleEnv = {
    setTimeout: (cb, ms) => {
      const id = next++
      timers.set(id, { cb, ms })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (h) => {
      timers.delete(h as unknown as number)
    },
    ...(opts.idle
      ? {
          requestIdleCallback: (cb: () => void, options?: { timeout: number }) => {
            const id = next++
            idle.set(id, cb)
            idleOptions.push(options)
            return id
          },
          cancelIdleCallback: (h: number) => {
            idle.delete(h)
          },
        }
      : {}),
    ...(opts.observer
      ? {
          IntersectionObserver: class {
            constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
              seen = cb
            }
            observe(el: Element) {
              observed = el
            }
            disconnect() {
              disconnected = true
            }
          },
        }
      : {}),
  }
  return {
    env,
    idle,
    timers,
    idleOptions,
    fireIdle: () => {
      for (const cb of [...idle.values()]) cb()
    },
    fireTimers: () => {
      for (const t of [...timers.values()]) t.cb()
    },
    intersect: (isIntersecting: boolean) => seen?.([{ isIntersecting }]),
    observed: () => observed,
    disconnected: () => disconnected,
  }
}

const card = {} as Element

test('the check never starts on the spot: it waits for the browser to be idle, with a deadline', () => {
  const f = fakeEnv({ idle: true, observer: true })
  let runs = 0
  whenIdleOrSeen(card, () => runs++, f.env)
  expect(runs).toBe(0)
  expect(f.idleOptions).toEqual([{ timeout: IDLE_TIMEOUT_MS }])
  f.fireIdle()
  expect(runs).toBe(1)
  // Once only: the card scrolling into view afterwards starts nothing more, and the observer is gone.
  f.intersect(true)
  expect(runs).toBe(1)
  expect(f.disconnected()).toBe(true)
})

test('the card scrolling into view starts the check before the idle time, once', () => {
  const f = fakeEnv({ idle: true, observer: true })
  let runs = 0
  whenIdleOrSeen(card, () => runs++, f.env)
  expect(f.observed()).toBe(card)
  f.intersect(false)
  expect(runs).toBe(0)
  f.intersect(true)
  expect(runs).toBe(1)
  expect(f.idle.size).toBe(0)
  f.fireIdle()
  expect(runs).toBe(1)
})

test('without idle callbacks (Safari) a short pause stands in for them', () => {
  const f = fakeEnv({ idle: false, observer: false })
  let runs = 0
  whenIdleOrSeen(card, () => runs++, f.env)
  expect([...f.timers.values()].map((t) => t.ms)).toEqual([IDLE_FALLBACK_MS])
  expect(runs).toBe(0)
  f.fireTimers()
  expect(runs).toBe(1)
})

test('leaving the screen first cancels everything: the check never starts', () => {
  const f = fakeEnv({ idle: false, observer: true })
  let runs = 0
  const cancel = whenIdleOrSeen(card, () => runs++, f.env)
  cancel()
  expect(f.timers.size).toBe(0)
  expect(f.disconnected()).toBe(true)
  f.intersect(true)
  expect(runs).toBe(0)
})
