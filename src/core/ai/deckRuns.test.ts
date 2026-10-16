import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { createWorkspace } from '../model/workspace'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { memoryStore } from '../storage/memoryStore'
import { DECK_RUN_PREFIX, migrateDeckRuns } from './deckRuns'

function setup() {
  const clock = virtualClock(1_000)
  const ws = createWorkspace(new Y.Doc(), { rng: seededRng(3, clock), clock, deviceId: 'dev' })
  const store = memoryStore()
  const courseId = ws.courses.create({ title: 'Biology' })
  const sourceId = ws.sources.create({ courseId, kind: 'pdf', title: 'Cells.pdf' })
  return { ws, store, courseId, sourceId }
}

const draft = (unit: number, front: string, status: string, more: object = {}) => ({
  id: `${unit}-${front}`,
  unit,
  kind: 'basic',
  type: 'qa',
  difficulty: 'easy',
  front,
  back: `about ${front}`,
  status,
  ...more,
})

describe('runs of the former « Create cards » screen', () => {
  test('become suggested drafts (rejected ones stay rejected), once, and the stored runs go', async () => {
    const { ws, store, courseId, sourceId } = setup()
    const gone = ws.sources.create({ courseId, kind: 'pdf', title: 'Old.pdf' })
    ws.sources.trash(gone)
    await store.commit([
      {
        put: 'kv',
        key: `${DECK_RUN_PREFIX}${sourceId}`,
        value: {
          v: 1,
          settings: { sectionId: '' },
          units: [1, 2],
          progress: { done: {} },
          drafts: [
            draft(1, 'What is a cell?', 'pending', { quote: 'A cell is…' }),
            draft(2, 'What is osmosis?', 'accepted'),
            draft(2, 'Bad', 'rejected'),
            { ...draft(2, 'No blank', 'pending'), kind: 'cloze' },
            { unit: 'x' },
          ],
          rejected: ['Never again'],
        },
      },
      { put: 'kv', key: `${DECK_RUN_PREFIX}${gone}`, value: { v: 1, drafts: [draft(1, 'Lost', 'pending')] } },
      { put: 'kv', key: 'other', value: 1 },
    ])
    expect(await migrateDeckRuns(ws, store)).toBe(4)
    const proposed = ws.drafts.list()
    expect(proposed.map((d) => [d.unit, d.front, d.sourceId, d.courseId, d.difficulty])).toEqual([
      [1, 'What is a cell?', sourceId, courseId, 'easy'],
      [2, 'What is osmosis?', sourceId, courseId, 'easy'],
    ])
    expect(proposed[0]?.quote).toBe('A cell is…')
    expect(ws.drafts.isRejected('bad')).toBe(true)
    expect(ws.drafts.isRejected('never again')).toBe(true)
    const keys = await store.read(['kv'], (tx) => tx.getAllKeys('kv'))
    expect(keys).toEqual(['other'])
    // Run again (another tab, a run cut half-way): nothing written twice.
    await store.commit([
      {
        put: 'kv',
        key: `${DECK_RUN_PREFIX}${sourceId}`,
        value: { v: 1, drafts: [draft(1, 'what is a CELL', 'pending')], rejected: ['Bad'] },
      },
    ])
    expect(await migrateDeckRuns(ws, store)).toBe(0)
    expect(ws.drafts.all()).toHaveLength(4)
  })
})
