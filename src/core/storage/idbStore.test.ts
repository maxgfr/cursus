import { expect, test } from 'bun:test'
import { DB_NAME, idbStore, LocalQuotaError, toStoreError } from './idbStore'
import { localStoreContract } from './localStore.contract'
import { estimate, persisted, requestPersistence } from './persist'

let n = 0
localStoreContract('indexeddb', () => idbStore({ name: `cursus-test-${n++}` }))

test('default database name is cursus-v1', () => {
  expect(DB_NAME).toBe('cursus-v1')
})

test('QuotaExceededError maps to LocalQuotaError; other errors pass through', () => {
  const q = toStoreError(new DOMException('full', 'QuotaExceededError'))
  expect(q).toBeInstanceOf(LocalQuotaError)
  expect((q as LocalQuotaError).cause).toBeInstanceOf(DOMException)
  expect(toStoreError(q)).toBe(q)
  const other = new Error('x')
  expect(toStoreError(other)).toBe(other)
})

test('a closed connection is reopened transparently', async () => {
  const s = idbStore({ name: `cursus-test-close-${n++}` })
  await s.commit([{ put: 'kv', key: 'a', value: 1 }])
  s.close()
  expect(await s.read(['kv'], (tx) => tx.get('kv', 'a'))).toBe(1)
  s.close()
  s.close()
  await s.commit([{ put: 'kv', key: 'b', value: 2 }])
  expect(await s.read(['kv'], (tx) => tx.count('kv'))).toBe(2)
})

test('a newer schema elsewhere closes us and reports versionchange; open is retried', async () => {
  const name = `cursus-test-vc-${n++}`
  let changed = 0
  const s = idbStore({ name, onVersionChange: () => changed++ })
  await s.commit([{ put: 'kv', key: 'a', value: 1 }])
  const upgrade = indexedDB.open(name, 2)
  await new Promise<void>((resolve, reject) => {
    upgrade.onsuccess = () => {
      upgrade.result.close()
      resolve()
    }
    upgrade.onerror = () => reject(upgrade.error)
  })
  expect(changed).toBe(1)
})

test('persistence helpers degrade gracefully', async () => {
  expect(await requestPersistence(undefined)).toBe(false)
  expect(await persisted(undefined)).toBe(false)
  expect(await estimate(undefined)).toBeNull()
  expect(await estimate({ estimate: async () => ({}) })).toBeNull()
  expect(await estimate({ estimate: async () => ({ usage: 1, quota: 9 }) })).toEqual({ usage: 1, quota: 9 })
  expect(await requestPersistence({ persist: async () => true, persisted: async () => true })).toBe(true)
  let asked = 0
  expect(
    await requestPersistence({
      persist: async () => {
        asked++
        return false
      },
      persisted: async () => false,
    }),
  ).toBe(false)
  expect(asked).toBe(1)
  expect(await requestPersistence({ persist: async () => true })).toBe(true)
  expect(await persisted({ persisted: async () => true })).toBe(true)
  expect(await requestPersistence()).toBe(false)
})
