import { describe, expect, test } from 'bun:test'
import type { LocalStore } from '../contracts/ports'
import { secretsVault } from './secrets'

/** One contract suite shared by every LocalStore implementation. */
export function localStoreContract(label: string, make: () => Promise<LocalStore> | LocalStore): void {
  describe(`LocalStore contract: ${label}`, () => {
    test('put/get round-trips structured values including bytes', async () => {
      const s = await make()
      const value = { a: 1, bytes: new Uint8Array([1, 2, 3]), nested: { b: 'x' } }
      await s.commit([{ put: 'kv', key: 'k', value }])
      const got = await s.read(['kv'], (tx) => tx.get<typeof value>('kv', 'k'))
      expect(got).toEqual(value)
      expect(got?.bytes).toBeInstanceOf(Uint8Array)
      expect(await s.read(['kv'], (tx) => tx.get('kv', 'missing'))).toBeUndefined()
    })

    test('stored values are copies, not aliases', async () => {
      const s = await make()
      const value = { n: 1 }
      await s.commit([{ put: 'kv', key: 'k', value }])
      value.n = 2
      const got = await s.read(['kv'], (tx) => tx.get<{ n: number }>('kv', 'k'))
      expect(got?.n).toBe(1)
    })

    test('add without key auto-increments in order; deleteRange removes up to K inclusive', async () => {
      const s = await make()
      await s.commit([{ add: 'pending', value: 'a' }])
      await s.commit([
        { add: 'pending', value: 'b' },
        { add: 'pending', value: 'c' },
      ])
      const keys = await s.read(['pending'], (tx) => tx.getAllKeys('pending'))
      expect(keys).toEqual([1, 2, 3])
      await s.commit([{ deleteRange: 'pending', upTo: 2 }])
      expect(await s.read(['pending'], (tx) => tx.getAll<string>('pending'))).toEqual(['c'])
      await s.commit([{ add: 'pending', value: 'd' }])
      expect(await s.read(['pending'], (tx) => tx.getAllKeys('pending'))).toEqual([3, 4])
    })

    test('getAll and getAllKeys honour inclusive ranges and key order', async () => {
      const s = await make()
      await s.commit(['d', 'a', 'c', 'b'].map((k) => ({ put: 'segments' as const, key: k, value: k.toUpperCase() })))
      await s.commit([{ put: 'segments', key: 5, value: 'five' }])
      expect(await s.read(['segments'], (tx) => tx.getAllKeys('segments'))).toEqual([5, 'a', 'b', 'c', 'd'])
      expect(await s.read(['segments'], (tx) => tx.getAll('segments', { lower: 'b', upper: 'c' }))).toEqual(['B', 'C'])
      expect(await s.read(['segments'], (tx) => tx.getAllKeys('segments', { lower: 'c' }))).toEqual(['c', 'd'])
      expect(await s.read(['segments'], (tx) => tx.getAllKeys('segments', { upper: 'a' }))).toEqual([5, 'a'])
      expect(await s.read(['segments'], (tx) => tx.count('segments'))).toBe(5)
    })

    test('delete removes one key; put overwrites', async () => {
      const s = await make()
      await s.commit([
        { put: 'kv', key: 'a', value: 1 },
        { put: 'kv', key: 'b', value: 2 },
      ])
      await s.commit([
        { put: 'kv', key: 'a', value: 3 },
        { delete: 'kv', key: 'b' },
      ])
      expect(await s.read(['kv'], (tx) => tx.getAll('kv'))).toEqual([3])
    })

    test('a failing commit is all or nothing', async () => {
      const s = await make()
      await s.commit([{ put: 'kv', key: 'dup', value: 1 }])
      await expect(
        s.commit([
          { put: 'kv', key: 'other', value: 2 },
          { put: 'segments', key: 'seg', value: 3 },
          { add: 'kv', key: 'dup', value: 4 },
        ]),
      ).rejects.toBeDefined()
      expect(await s.read(['kv'], (tx) => tx.get('kv', 'other'))).toBeUndefined()
      expect(await s.read(['segments'], (tx) => tx.count('segments'))).toBe(0)
      expect(await s.read(['kv'], (tx) => tx.get('kv', 'dup'))).toBe(1)
    })

    test('read spanning several stores sees a consistent view', async () => {
      const s = await make()
      await s.commit([
        { put: 'kv', key: 'seq', value: 7 },
        { add: 'pending', value: 'u' },
      ])
      const out = await s.read(['kv', 'pending'], async (tx) => ({
        seq: await tx.get<number>('kv', 'seq'),
        n: await tx.count('pending'),
      }))
      expect(out).toEqual({ seq: 7, n: 1 })
    })

    test('empty commit is a no-op', async () => {
      const s = await make()
      await s.commit([])
      expect(await s.read(['kv'], (tx) => tx.count('kv'))).toBe(0)
    })

    test('secrets vault stores, lists and deletes device-only values', async () => {
      const s = await make()
      const v = secretsVault(s)
      expect(await v.get('drive')).toBeUndefined()
      await v.set('drive', { refresh: 'r' })
      await v.set('s3', 'k')
      expect(await v.get<{ refresh: string }>('drive')).toEqual({ refresh: 'r' })
      expect((await v.names()).sort()).toEqual(['drive', 's3'])
      await v.delete('drive')
      expect(await v.names()).toEqual(['s3'])
      expect(() => v.set('', 1)).toThrow(RangeError)
    })
  })
}
