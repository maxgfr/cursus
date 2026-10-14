import { expect, test } from 'bun:test'
import { dropReturnsOf, type QueueEntry } from './session.ts'

test('undoing a grade takes back the return it caused, and only that one', () => {
  const q: QueueEntry[] = [{ id: 'a' }, { id: 'b' }, { id: 'a', returnOf: 'r1' }, { id: 'b', returnOf: 'r2' }]
  expect(dropReturnsOf(q, 'r1')).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'b', returnOf: 'r2' }])
})
