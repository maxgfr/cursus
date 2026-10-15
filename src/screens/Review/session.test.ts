import { expect, test } from 'bun:test'
import * as Y from 'yjs'
import { createWorkspace } from '../../core/model/workspace'
import { virtualClock } from '../../core/ports/clock'
import { seededRng } from '../../core/ports/rng'
import { dropReturnsOf, type QueueEntry, readCard } from './session.ts'

test('undoing a grade takes back the return it caused, and only that one', () => {
  const q: QueueEntry[] = [{ id: 'a' }, { id: 'b' }, { id: 'a', returnOf: 'r1' }, { id: 'b', returnOf: 'r2' }]
  expect(dropReturnsOf(q, 'r1')).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'b', returnOf: 'r2' }])
})

test('a fill-in-the-blank card asks its blanks in turn, one per review, the others shown answered', () => {
  const now = new Date(2026, 9, 15, 12).getTime()
  const clock = virtualClock(now)
  const ws = createWorkspace(new Y.Doc(), { rng: seededRng(1, clock), clock, deviceId: 'dev1' })
  const courseId = ws.courses.create({ title: 'Cells' })
  const id = ws.batch(() => {
    const id = ws.cards.create({ courseId, kind: 'cloze' })
    ws.text({ id, field: 'front' }).insert(0, 'The {{c1::nucleus}} holds the {{c2::DNA::molecule}}.')
    ws.text({ id, field: 'back' }).insert(0, 'Seen in lecture 2.')
    return id
  })
  const asked = () => {
    const card = readCard(ws, id, clock.now())
    return [card?.front, card?.back]
  }
  const answer = 'The nucleus holds the DNA.\n\nSeen in lecture 2.'
  expect(asked()).toEqual(['The [...] holds the DNA.', answer])
  ws.reviews.record({ cardId: id, rating: 3, at: now, ms: 4000 })
  expect(asked()).toEqual(['The nucleus holds the [molecule].', answer])
  // A practice review counts as a turn too: the next time, the first blank again.
  ws.reviews.record({ cardId: id, rating: 3, at: now + 60_000, ms: 4000, p: true })
  expect(asked()).toEqual(['The [...] holds the DNA.', answer])
})
