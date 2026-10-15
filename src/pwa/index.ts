/// <reference types="vite-plugin-pwa/client" />

import { probeWorker } from './worker.ts'

/** The PWA layer: service worker registration, the waiting update, storage persistence. */
export interface PwaUpdate {
  /** Finishes pending writes and seals pending edits, then activates the waiting worker and reloads. */
  apply(): Promise<void>
}

export interface PwaOptions {
  /** Seals the local log; awaited before the page reloads into the new version. */
  seal(): Promise<void>
  /** Records a failure the user is not told about (the next check may well succeed). */
  report(where: string, e: unknown): void
}

/** Where the build emits the worker (vite-plugin-pwa's default `filename`, at `base`) and the scope it controls. */
const SCOPE = import.meta.env.BASE_URL
const WORKER_URL = `${SCOPE}sw.js`

let starting: Promise<void> | null = null
let registration: ServiceWorkerRegistration | null = null
/** The one waiting update, shared by the toast and Settings: one worker, one apply path. */
let waiting: PwaUpdate | null = null
const watchers = new Set<() => void>()
const flushers = new Set<() => Promise<void>>()

/** Screens offering the update in place (Settings): the toast steps aside meanwhile. */
let inPlace = 0
const notify = () => {
  for (const fn of watchers) fn()
}

/** The waiting update, if a new version is installed and ready. */
export const pendingUpdate = (): PwaUpdate | null => waiting

/** The waiting update for the toast: none while a screen offers it in place. */
export const toastUpdate = (): PwaUpdate | null => (inPlace > 0 ? null : waiting)

/** Marks the update as offered in place until the returned function is called. */
export function offerInPlace(): () => void {
  inPlace++
  notify()
  return () => {
    inPlace--
    notify()
  }
}

/** Calls `fn` whenever a new version starts waiting, or the toast should show or hide it; returns the unsubscribe. */
export function subscribeUpdate(fn: () => void): () => void {
  watchers.add(fn)
  return () => watchers.delete(fn)
}

/** The registration once `startPwa` is done; null in dev and where service workers are absent or blocked. */
export async function pwaRegistration(): Promise<ServiceWorkerRegistration | null> {
  await starting
  return registration
}

/**
 * Registers a write that must land before the page reloads into a new version (a debounced draft);
 * returns the unregister.
 */
export function beforeUpdate(flush: () => Promise<void>): () => void {
  flushers.add(flush)
  return () => flushers.delete(flush)
}

/** Runs every registered write now (before any reload). */
export const flushPending = (): Promise<unknown> => Promise.all(Array.from(flushers, (f) => f()))

/**
 * Registers the service worker once; resolves when registered. A no-op in dev and where service workers are
 * absent or blocked (no update machinery then, and nothing to report). Rejects when the deferred chunks or the
 * worker script fail to load, and may then be called again.
 */
export function startPwa(opts: PwaOptions): Promise<void> {
  starting ??= register(opts).catch((e: unknown) => {
    starting = null
    throw e
  })
  return starting
}

async function register(opts: PwaOptions): Promise<void> {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
  const { registerSW } = await import('virtual:pwa-register')
  // workbox-window assumes `register()` hands back a registration; where it is blocked, stop here.
  if (!(await probeWorker(navigator.serviceWorker, WORKER_URL, SCOPE))) return
  await new Promise<void>((resolve, reject) => {
    const updateSW = registerSW({
      // The page has long loaded by the time this lazy chunk runs: register now, not on `load`.
      immediate: true,
      onNeedRefresh() {
        waiting = {
          async apply() {
            await flushPending()
            await opts.seal()
            await updateSW(true)
          },
        }
        notify()
      },
      onRegisteredSW(_url, reg) {
        registration = reg ?? null
        resolve()
        if (!reg) return
        // Check for a new version on every return to the foreground (installed apps rarely reload).
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && navigator.onLine)
            reg.update().catch((e: unknown) => opts.report('pwa.update', e))
        })
      },
      // workbox-window failed to load, or the worker failed to register.
      onRegisterError: reject,
    })
  })
}

export { requestPersistence } from '../core/storage/persist.ts'

/** Device-local flag in IndexedDB `cursus-v1` store `kv` (never in the Y.Doc): the iOS install hint was dismissed. */
export const INSTALL_HINT_KEY = 'pwa:install-hint-dismissed'

/** iOS Safari, not installed: the only way to install is Share → Add to Home Screen. */
export function needsIosInstallHint(): boolean {
  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return ios && !standalone && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
}

/** URLs of pdf.js cmaps and standard fonts, emitted (and so precached) by the build; loaded on demand. */
export const loadPdfAssets = () => import('./pdfAssets.ts')
