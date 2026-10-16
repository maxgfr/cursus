import { ONBOARDED_KEY } from '../../../app/onboarding.ts'
import { CACHE_PREFIX } from '../../../core/ai/local'
import { DB_NAME } from '../../../core/storage/idbStore'
import { SHOW_MARKDOWN_KEY } from '../../../ui/editor/prefs.ts'

/** The device flags the app keeps in `localStorage`. */
const DEVICE_KEYS = [ONBOARDED_KEY, SHOW_MARKDOWN_KEY]

export interface EraseHooks {
  /** Closes this page's own connection to the library first, so it does not hold the deletion. */
  close: () => void
  /** Another tab still has the library open: the deletion waits for it to close. */
  onBlocked: () => void
}

/** Deletes the local library database; resolves once it is gone (after any other tab let go of it). */
function deleteDatabase(onBlocked: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('The local library could not be deleted'))
    req.onblocked = onBlocked
  })
}

/**
 * Erases everything this app keeps on this device: the library (courses, cards, sources, sessions, settings, AI
 * keys, conversations), the on-device model files and the device flags. Remote destinations are never touched.
 * The database goes first: should it fail, the rest stays as it was.
 */
export async function eraseThisDevice(hooks: EraseHooks): Promise<void> {
  hooks.close()
  await deleteDatabase(hooks.onBlocked)
  if (typeof caches !== 'undefined') {
    const names = (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX))
    await Promise.all(names.map((n) => caches.delete(n)))
  }
  for (const key of DEVICE_KEYS) localStorage.removeItem(key)
}
