import { expect, test } from 'bun:test'
import * as Y from 'yjs'
import { createWorkspace } from '../../core/model/workspace'
import { virtualClock } from '../../core/ports/clock'
import { seededRng } from '../../core/ports/rng'
import { computeStudy } from '../../ui/data/useStudy.ts'
import { sectionExamLead } from './sectionLead.ts'

const DAY = 86_400_000
const now = new Date(2026, 9, 14, 15).getTime()

function library(newUsedElsewhere: number) {
  const clock = virtualClock(now)
  const ws = createWorkspace(new Y.Doc(), { rng: seededRng(3, clock), clock, deviceId: 'dev' })
  ws.prefs.set('dailyNewCards', 20)
  const other = ws.courses.create({ title: 'History' })
  const law = ws.courses.create({ title: 'Law' })
  const contracts = ws.sections.create({ courseId: law, name: 'Contracts', examDate: '2026-10-19' })
  for (let i = 0; i < 12; i++) ws.cards.create({ courseId: law, sectionId: contracts, kind: 'basic' })
  // New cards learned earlier today, elsewhere: they spend the daily budget.
  for (let i = 0; i < newUsedElsewhere; i++) {
    const id = ws.cards.create({ courseId: other, kind: 'basic' })
    ws.reviews.record({ cardId: id, rating: 4, at: now - 3_600_000, ms: 4_000 })
  }
  // Three reviews due today, elsewhere.
  for (let i = 0; i < 3; i++) {
    const id = ws.cards.create({ courseId: other, kind: 'basic' })
    ws.reviews.record({ cardId: id, rating: 4, at: now - 60 * DAY, ms: 4_000 })
  }
  return ws
}

test('the chapter lead counts only cards Today actually queues: none once the new-card budget is spent', () => {
  const ws = library(20)
  const total = computeStudy(ws, now).due
  expect(total).toBe(3)
  const lead = sectionExamLead(ws, now)
  expect(lead?.due ?? 0).toBe(0)
})

test('the chapter lead is its share of the real queue, never more than the total', () => {
  const ws = library(15)
  const total = computeStudy(ws, now).due
  const lead = sectionExamLead(ws, now)
  expect(lead).toMatchObject({ title: 'Contracts', days: 5 })
  expect(lead?.due).toBeLessThanOrEqual(total)
  // 5 new cards left in the budget; History's earlier ids may take some, Contracts never more than 5.
  expect(lead?.due).toBeLessThanOrEqual(5)
})
