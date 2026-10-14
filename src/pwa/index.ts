/// <reference types="vite-plugin-pwa/client" />

/** The PWA layer: service worker registration, the update prompt, storage persistence. */
export interface PwaUpdate {
  /** Seals pending edits, then activates the waiting worker and reloads. */
  apply(): Promise<void>
}

export interface PwaOptions {
  /** A new worker waits. */
  onUpdate(update: PwaUpdate): void
  /** Seals the local log; awaited before the page reloads into the new version. */
  seal(): Promise<void>
  /** Records a failure the user is not told about (the next check may well succeed). */
  report(where: string, e: unknown): void
}

let started = false

/**
 * Registers the service worker once; resolves when registered. A no-op where service workers are unavailable
 * or in dev. Rejects when the deferred chunks or the worker script fail to load, and may then be called again.
 */
export async function startPwa(opts: PwaOptions): Promise<void> {
  if (started || !('serviceWorker' in navigator) || import.meta.env.DEV) return
  started = true
  try {
    const { registerSW } = await import('virtual:pwa-register')
    await new Promise<void>((resolve, reject) => {
      const updateSW = registerSW({
        // The page has long loaded by the time this lazy chunk runs: register now, not on `load`.
        immediate: true,
        onNeedRefresh() {
          opts.onUpdate({
            async apply() {
              await opts.seal()
              await updateSW(true)
            },
          })
        },
        onRegisteredSW(_url, registration) {
          resolve()
          if (!registration) return
          // Check for a new version on every return to the foreground (installed apps rarely reload).
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && navigator.onLine)
              registration.update().catch((e: unknown) => opts.report('pwa.update', e))
          })
        },
        // workbox-window failed to load, or the worker failed to register.
        onRegisterError: reject,
      })
    })
  } catch (e) {
    started = false
    throw e
  }
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
