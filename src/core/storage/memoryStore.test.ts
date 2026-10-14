import { expect, test } from 'bun:test'
import type { StoreName } from '../contracts/ports'
import { localStoreContract } from './localStore.contract'
import { compareKeys, memoryStore } from './memoryStore'

localStoreContract('memory', () => memoryStore())

test('compareKeys orders numbers before strings', () => {
  expect([3, 'b', 1, 'a'].sort(compareKeys)).toEqual([1, 3, 'a', 'b'])
  expect(compareKeys('a', 'a')).toBe(0)
})

test('explicit numeric keys advance the generator', async () => {
  const s = memoryStore()
  await s.commit([
    { put: 'pending', key: 10, value: 'x' },
    { add: 'pending', value: 'y' },
  ])
  expect(await s.read(['pending'], (tx) => tx.getAllKeys('pending'))).toEqual([10, 11])
  expect(s.size('pending')).toBe(2)
})

test('unknown store is rejected', async () => {
  const s = memoryStore()
  await expect(s.read(['nope'] as unknown as StoreName[], async () => 1)).rejects.toThrow('Unknown store')
})
