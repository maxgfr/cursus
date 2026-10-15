/**
 * Runs `run` once, when the browser is first idle or when `target` first scrolls into view, whichever comes
 * first; never on the spot. The on-device check (a chunk load, then a GPU probe) starts this way so it never
 * competes with the first thing the student does on the settings screen, such as typing in the search.
 * Returns the cancel, for an unmount before either happened.
 */
export interface IdleEnv {
  requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
  IntersectionObserver?: new (
    cb: (entries: { isIntersecting: boolean }[]) => void,
  ) => { observe: (el: Element) => void; disconnect: () => void }
}

/** Without idle callbacks (Safari), a pause long enough for the screen's first interaction to settle. */
export const IDLE_FALLBACK_MS = 600
/** Idle callbacks are not guaranteed under a busy main thread: the check still starts by then. */
export const IDLE_TIMEOUT_MS = 2000

export function whenIdleOrSeen(target: Element | null, run: () => void, env: IdleEnv = browserEnv()): () => void {
  let done = false
  const cleanups: (() => void)[] = []
  const cancel = () => {
    for (const c of cleanups.splice(0)) c()
  }
  const fire = () => {
    if (done) return
    done = true
    cancel()
    run()
  }

  if (env.requestIdleCallback) {
    const handle = env.requestIdleCallback(fire, { timeout: IDLE_TIMEOUT_MS })
    const cancelIdle = env.cancelIdleCallback
    if (cancelIdle) cleanups.push(() => cancelIdle(handle))
  } else {
    const handle = env.setTimeout(fire, IDLE_FALLBACK_MS)
    cleanups.push(() => env.clearTimeout(handle))
  }

  if (target && env.IntersectionObserver) {
    const observer = new env.IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) fire()
    })
    observer.observe(target)
    cleanups.push(() => observer.disconnect())
  }

  return () => {
    done = true
    cancel()
  }
}

function browserEnv(): IdleEnv {
  return {
    ...(typeof window.requestIdleCallback === 'function'
      ? {
          requestIdleCallback: (cb, options) => window.requestIdleCallback(cb, options),
          cancelIdleCallback: (h) => window.cancelIdleCallback(h),
        }
      : {}),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h),
    ...(typeof window.IntersectionObserver === 'function' ? { IntersectionObserver: window.IntersectionObserver } : {}),
  }
}
