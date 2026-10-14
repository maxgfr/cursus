import type { Locks } from '../contracts/ports'

/** In-memory exclusive locks with FIFO queueing per name. */
export function memoryLocks(): Locks {
  const tails = new Map<string, Promise<void>>()
  const held = new Set<string>()
  return {
    async run<T>(name: string, fn: () => Promise<T>, o?: { ifAvailable?: boolean }): Promise<T | null> {
      if (o?.ifAvailable && (held.has(name) || tails.has(name))) return null
      const prev = tails.get(name) ?? Promise.resolve()
      let release = () => {}
      const mine = new Promise<void>((r) => {
        release = r
      })
      const tail = prev.then(() => mine)
      tails.set(name, tail)
      await prev
      held.add(name)
      try {
        return await fn()
      } finally {
        held.delete(name)
        release()
        if (tails.get(name) === tail) tails.delete(name)
      }
    },
  }
}

interface WebLockManager {
  request<T>(name: string, options: { ifAvailable?: boolean }, cb: (lock: unknown) => Promise<T>): Promise<T>
}

/** Web Locks API wrapper; null when the lock was not available with ifAvailable. */
export function webLocks(manager: WebLockManager): Locks {
  return {
    run<T>(name: string, fn: () => Promise<T>, o?: { ifAvailable?: boolean }): Promise<T | null> {
      return manager.request<T | null>(name, { ifAvailable: o?.ifAvailable ?? false }, (lock) =>
        lock === null ? Promise.resolve(null) : fn(),
      )
    },
  }
}

/** navigator.locks when present (browsers), in-memory fallback otherwise (Bun). */
export function defaultLocks(nav: { locks?: WebLockManager } | undefined = globalThis.navigator): Locks {
  return nav?.locks ? webLocks(nav.locks) : memoryLocks()
}
