/**
 * Every deferred chunk load (lazy screens and components, the sync engine, catalogs, the PWA layer) goes
 * through here, so that no rejected load is ever left unhandled. A navigation away aborts the page's pending
 * loads: that rejection is the navigation itself and is dropped. Anything else is recorded for the diagnostic
 * report and the caller degrades (a calm retry, a missing extra), never a blank screen.
 */

/** What the page around a load looks like; injectable for tests. */
export interface PageEnv {
  /** The page is provably going away: unloading (beforeunload or pagehide seen) or hidden. */
  leaving(): boolean
  online(): boolean
  /** Runs `then` once, on the next return to the foreground (visible again, or focused after a blur). */
  onNextForeground(then: () => void): void
}

export type Report = (where: string, e: unknown) => void

/** A failed load of a deferred chunk or of the worker script, or anything while offline: worth one more try. */
export function isTransient(e: unknown, online: boolean): boolean {
  if (!online) return true
  // Chromium "Failed to fetch dynamically imported module", WebKit "Importing a module script failed." /
  // "Load failed", Firefox "error loading dynamically imported module", worker "…fetching the script", Vite
  // "Unable to preload CSS".
  return e instanceof Error && /fetch|load|import|network/i.test(e.message)
}

/** Records a failed load unless the page is provably navigating away. True when it was such an abort. */
export function noteLoadFailure(where: string, e: unknown, report: Report, env: PageEnv = browserEnv()): boolean {
  if (env.leaving()) return true
  report(where, e)
  return false
}

/**
 * Loads a chunk. A real failure is recorded and rejects. An abort while the page is leaving stays pending:
 * the page is going away; should it come back to the foreground after all, the chunk is loaded once more.
 */
export function guardChunk<T>(load: () => Promise<T>, where: string, report: Report, env = browserEnv()): Promise<T> {
  return load().catch((e: unknown) => {
    if (!noteLoadFailure(where, e, report, env)) throw e
    return new Promise<T>((resolve, reject) =>
      env.onNextForeground(() =>
        load().then(resolve, (again: unknown) => {
          report(where, again)
          reject(again)
        }),
      ),
    )
  })
}

/**
 * Runs `start` (the service worker registration) without ever leaving its failure unhandled. A failure only
 * loses the update prompt. A transient failure, or an abort while merely hidden, is tried once more on the
 * next return to the foreground.
 */
export async function startResiliently(
  start: () => Promise<void>,
  report: Report,
  env: PageEnv = browserEnv(),
  retried = false,
): Promise<void> {
  try {
    await start()
  } catch (e) {
    const aborted = noteLoadFailure('pwa.start', e, report, env)
    if (!retried && (aborted || isTransient(e, env.online())))
      env.onNextForeground(() => void startResiliently(start, report, env, true))
  }
}

let unloading = false
let watching = false

/** Listens from the first import on, before any navigation can abort a load. */
function watch(): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  const leave = () => {
    unloading = true
  }
  const stay = () => {
    unloading = false
  }
  window.addEventListener('beforeunload', leave)
  window.addEventListener('pagehide', leave)
  // Back from the back/forward cache, or a leave the user cancelled and then went on using the page.
  window.addEventListener('pageshow', stay)
  window.addEventListener('pointerdown', stay, true)
  window.addEventListener('keydown', stay, true)
}
watch()

/** The real page. */
export function browserEnv(): PageEnv {
  watch()
  return {
    leaving: () => unloading || document.visibilityState === 'hidden',
    online: () => navigator.onLine,
    onNextForeground(then) {
      // A focus only counts once the page has lost it: WebKit focuses a page as it settles after loading.
      let away = false
      const blur = () => {
        away = true
      }
      const fire = (e: Event) => {
        if (document.visibilityState !== 'visible' || (e.type === 'focus' && !away)) return
        document.removeEventListener('visibilitychange', fire)
        window.removeEventListener('focus', fire)
        window.removeEventListener('pageshow', fire)
        window.removeEventListener('blur', blur)
        then()
      }
      document.addEventListener('visibilitychange', fire)
      window.addEventListener('focus', fire)
      window.addEventListener('pageshow', fire)
      window.addEventListener('blur', blur)
    },
  }
}
