import type { LocalStore } from '../core/contracts/ports'

/**
 * When this device last saved a backup file, in the device's own `kv` (never synced: another device's
 * export does not protect this one's changes). Today uses it for a weekly reminder when nothing automatic
 * keeps a copy.
 */
export const LAST_BACKUP_KEY = 'backup:lastExport'
export const REMIND_AFTER_DAYS = 7
const DAY = 86_400_000

export async function readLastBackup(store: LocalStore): Promise<number | undefined> {
  const v = await store.read(['kv'], (tx) => tx.get<unknown>('kv', LAST_BACKUP_KEY))
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export const noteBackup = (store: LocalStore, at: number): Promise<void> =>
  store.commit([{ put: 'kv', key: LAST_BACKUP_KEY, value: at }])

export type Reminder = { kind: 'none' } | { kind: 'never' } | { kind: 'stale'; days: number }

/**
 * What Today says about backups: nothing once a destination confirmed a copy or a backup file is recent;
 * « no backup yet » while nothing was ever saved (or a destination has not confirmed yet); « last backup
 * N days ago » once the last file is older than a week and no destination exists.
 */
export function backupReminder(o: {
  now: number
  last: number | undefined
  hasDestination: boolean
  backedUp: boolean
}): Reminder {
  if (o.backedUp) return { kind: 'none' }
  if (o.hasDestination || o.last === undefined) return { kind: 'never' }
  const days = Math.floor(Math.max(0, o.now - o.last) / DAY)
  return days >= REMIND_AFTER_DAYS ? { kind: 'stale', days } : { kind: 'none' }
}
