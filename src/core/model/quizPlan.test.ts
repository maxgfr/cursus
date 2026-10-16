import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { defaultQuizCount, failedLately, passagesOf, RECENT_LAPSE_MS, WEAK_MAX, weakCards } from './quizPlan'
import { createWorkspace } from './workspace'

const DAY = 24 * 3600_000
const NOW = 1_800_000_000_000

function setup() {
  const clock = virtualClock(NOW)
  const ws = createWorkspace(new Y.Doc(), { rng: seededRng(5, clock), clock, deviceId: 'd' })
  const courseId = ws.courses.create({ title: 'Physiology' })
  const sectionId = ws.sections.create({ courseId, name: 'Cardio' })
  const card = (front: string, inSection = false) => {
    const id = ws.cards.create({ courseId, kind: 'basic', ...(inSection ? { sectionId } : {}) })
    ws.text({ id, field: 'front' }).insert(0, front)
    return id
  }
  return { ws, courseId, sectionId, card }
}

describe('weak points of a course or a section', () => {
  test('forgotten cards and cards likely forgotten by now, most lapses first; new and suspended ones aside', () => {
    const { ws, courseId, sectionId, card } = setup()
    const fine = card('Fine card')
    const lapsed = card('Twice forgotten', true)
    const once = card('Forgotten once', true)
    const stale = card('Not seen for a year')
    card('Never reviewed')
    const suspended = card('Suspended and forgotten')
    for (const id of [fine, lapsed, once, stale, suspended]) {
      ws.reviews.record({ cardId: id, rating: 4, at: NOW - 400 * DAY, ms: 1000 })
    }
    ws.reviews.record({ cardId: fine, rating: 3, at: NOW - 2 * DAY, ms: 1000 })
    ws.reviews.record({ cardId: lapsed, rating: 3, at: NOW - 30 * DAY, ms: 1000 })
    ws.reviews.record({ cardId: lapsed, rating: 1, at: NOW - 20 * DAY, ms: 1000 })
    ws.reviews.record({ cardId: lapsed, rating: 3, at: NOW - 10 * DAY, ms: 1000 })
    ws.reviews.record({ cardId: lapsed, rating: 1, at: NOW - 5 * DAY, ms: 1000 })
    ws.reviews.record({ cardId: once, rating: 1, at: NOW - 3 * DAY, ms: 1000 })
    ws.reviews.record({ cardId: suspended, rating: 1, at: NOW - 3 * DAY, ms: 1000 })
    ws.cards.update(suspended, { suspended: true })

    const weak = weakCards(ws, { courseId }, NOW)
    expect(weak.map((w) => w.front)).toEqual(['Twice forgotten', 'Forgotten once', 'Not seen for a year'])
    expect(weak[0]?.lapses).toBeGreaterThan(weak[1]?.lapses ?? 0)
    expect(weak[2]?.recall).toBeLessThan(0.7)
    // A section holds only its own.
    expect(weakCards(ws, { courseId, sectionId }, NOW).map((w) => w.front)).toEqual([
      'Twice forgotten',
      'Forgotten once',
    ])
    expect(failedLately(weak, NOW)).toBe(true)
    expect(failedLately(weak, NOW + RECENT_LAPSE_MS)).toBe(false)
    expect(failedLately([], NOW)).toBe(false)
  })

  test('at most a handful, each front kept short and on one line', () => {
    const { ws, courseId, card } = setup()
    for (let i = 0; i < WEAK_MAX + 4; i++) {
      const id = card(`Card ${i}\n\n${'long '.repeat(80)}`)
      ws.reviews.record({ cardId: id, rating: 1, at: NOW - DAY, ms: 1000 })
    }
    const weak = weakCards(ws, { courseId }, NOW)
    expect(weak).toHaveLength(WEAK_MAX)
    expect(weak.every((w) => !w.front.includes('\n') && w.front.length <= 200)).toBe(true)
  })
})

describe('how many questions by default', () => {
  test('from the material: a short note asks a few, a thick course more', () => {
    expect([0, 2, 3, 6, 7, 15, 16, 80].map(defaultQuizCount)).toEqual([3, 3, 5, 5, 10, 10, 20, 20])
    const { ws, courseId, sectionId } = setup()
    const note = ws.sources.create({ courseId, sectionId, kind: 'note', title: 'Heart' })
    ws.text({ id: note, field: 'body' }).insert(0, 'x'.repeat(3000))
    ws.sources.create({ courseId, kind: 'image', title: 'Sketch' })
    expect(passagesOf(ws, { courseId, sectionId })).toBe(3)
    expect(passagesOf(ws, { courseId })).toBe(4)
    expect(defaultQuizCount(passagesOf(ws, { courseId }))).toBe(5)
  })
})
