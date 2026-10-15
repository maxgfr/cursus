import { describe, expect, test } from 'bun:test'
import { memoryStore } from '../core/storage/memoryStore'
import { backupReminder, LAST_BACKUP_KEY, noteBackup, readLastBackup } from './lastBackup.ts'

const DAY = 86_400_000
const now = 1_760_000_000_000

describe('backup reminder', () => {
  test('a confirmed destination silences it', () => {
    expect(backupReminder({ now, last: undefined, hasDestination: true, backedUp: true })).toEqual({ kind: 'none' })
  })

  test('nothing ever saved, or a destination not confirmed yet: no backup yet', () => {
    expect(backupReminder({ now, last: undefined, hasDestination: false, backedUp: false })).toEqual({ kind: 'never' })
    expect(backupReminder({ now, last: now, hasDestination: true, backedUp: false })).toEqual({ kind: 'never' })
  })

  test('without a destination, a file older than a week is recalled with its age', () => {
    expect(backupReminder({ now, last: now - 6 * DAY, hasDestination: false, backedUp: false })).toEqual({
      kind: 'none',
    })
    expect(backupReminder({ now, last: now - 7 * DAY, hasDestination: false, backedUp: false })).toEqual({
      kind: 'stale',
      days: 7,
    })
    expect(backupReminder({ now, last: now + DAY, hasDestination: false, backedUp: false })).toEqual({ kind: 'none' })
  })

  test('the time is kept in the device kv', async () => {
    const store = memoryStore()
    expect(await readLastBackup(store)).toBeUndefined()
    await noteBackup(store, now)
    expect(await readLastBackup(store)).toBe(now)
    await store.commit([{ put: 'kv', key: LAST_BACKUP_KEY, value: 'garbage' }])
    expect(await readLastBackup(store)).toBeUndefined()
  })
})
