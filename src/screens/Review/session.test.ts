import { expect, test } from 'bun:test'
import * as Y from 'yjs'
import { createWorkspace } from '../../core/model/workspace'
import { virtualClock } from '../../core/ports/clock'
import { seededRng } from '../../core/ports/rng'
import { dropReturnsOf, type QueueEntry, readCard, startQueue } from './session.ts'

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

test('Today’s queue goes course by course, the most behind first; a course’s share stays within the day’s budget', () => {
  const now = new Date(2026, 9, 15, 12).getTime()
  const clock = virtualClock(now)
  const ws = createWorkspace(new Y.Doc(), { rng: seededRng(1, clock), clock, deviceId: 'dev1' })
  ws.reviewSettings.set({ dailyNewCards: 3 })
  const anatomy = ws.courses.create({ title: 'Anatomy' })
  const law = ws.courses.create({ title: 'Law' })
  // Added one after the other, in this order.
  const add = (courseId: string) => {
    clock.advance(1000)
    return ws.cards.create({ courseId, kind: 'basic' })
  }
  const [a1, a2, b1, b2, b3] = [add(anatomy), add(anatomy), add(law), add(law), add(law)]
  // Answered Easy a month ago: a review long overdue, so Law comes first.
  const late = add(law)
  ws.reviews.record({ cardId: late, rating: 4, at: now - 30 * 86_400_000, ms: 4000 })
  // The new-card budget goes as the queue gives it (the order cards were added): Anatomy's two, then one of Law's.
  expect(startQueue(ws, now).queue).toEqual([late, b1, a1, a2])
  // « Review this course » from Today: Law's share, nothing more.
  expect(startQueue(ws, now, { courseId: law }, true).queue).toEqual([late, b1])
  expect(startQueue(ws, now, { courseId: anatomy }, true).queue).toEqual([a1, a2])
  // From the course itself, as before: the whole budget is the course's to take.
  expect(startQueue(ws, now, { courseId: law }).queue).toEqual([late, b1, b2, b3])
})
