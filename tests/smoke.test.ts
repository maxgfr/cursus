import { expect, test } from 'bun:test'
import fc from 'fast-check'

test('fake-indexeddb is preloaded', () => {
  expect(typeof indexedDB.open).toBe('function')
})

test('fast-check runs', () => {
  fc.assert(
    fc.property(fc.integer(), (n) => n + 0 === n),
    { numRuns: Number(process.env.FC_RUNS ?? 100) },
  )
})
