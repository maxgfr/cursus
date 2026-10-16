import { CACHE_PREFIX } from '../../../core/ai/local'
import { DB_NAME } from '../../../core/storage/idbStore'
import { localDatabases } from '../Recovery/rawExport.ts'

/** What every device-local key of the app starts with, in `localStorage` and `sessionStorage`. */
const KEY_PREFIX = 'cursus:'

export interface EraseHooks {
  /**
   * Stops everything that could write to this device while it is erased (sync, the AI queue, the library's own
   * seals) and lets go of the library, so nothing holds the deletion or brings a database back afterwards.
   */
  stop: () => Promise<void>
  /** Another tab still has the library open: the deletion waits for it to close. */
  onBlocked: () => void
}

/** The app's own keys among those of a storage: every `cursus:` one, whatever wrote it. */
export function keysToErase(keys: readonly string[]): string[] {
  return keys.filter((k) => k.startsWith(KEY_PREFIX))
}

/** Deletes a database; resolves once it is gone (after any other tab let go of it). */
function deleteDatabase(name: string, onBlocked: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error(`The local database ${name} could not be deleted`))
    req.onblocked = onBlocked
  })
}

function eraseKeys(storage: Storage): void {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key !== null) keys.push(key)
  }
  for (const key of keysToErase(keys)) storage.removeItem(key)
}

/**
 * Erases everything this app keeps on this device: the library (courses, cards, sources, sessions, settings, AI
 * keys, conversations) and any other database of the app, the on-device model files and the device's own keys.
 * Remote destinations are never touched. What writes is stopped first; the library's database goes next: should it
 * fail, the rest stays as it was.
 */
export async function eraseThisDevice(hooks: EraseHooks): Promise<void> {
  await hooks.stop()
  await deleteDatabase(DB_NAME, hooks.onBlocked)
  for (const name of await localDatabases()) if (name !== DB_NAME) await deleteDatabase(name, hooks.onBlocked)
  if (typeof caches !== 'undefined') {
    const names = (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX))
    await Promise.all(names.map((n) => caches.delete(n)))
  }
  eraseKeys(localStorage)
  eraseKeys(sessionStorage)
}
