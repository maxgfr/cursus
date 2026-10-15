import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { createWorkspace } from '../../core/model/workspace'
import { virtualClock } from '../../core/ports/clock'
import { seededRng } from '../../core/ports/rng'
import { saveDraftCards } from './deckInputs'

describe('saveDraftCards', () => {
  test('each card keeps its source and the unit it was made from', () => {
    const clock = virtualClock(1_000)
    const ws = createWorkspace(new Y.Doc(), { rng: seededRng(3, clock), clock, deviceId: 'dev' })
    const courseId = ws.courses.create({ title: 'Biology' })
    const sectionId = ws.sections.create({ courseId, name: 'Cells' })
    const sourceId = ws.sources.create({ courseId, kind: 'note', support: 'deck', title: 'Slides', blobId: 'b' })
    const [osmosis, cloze, whole] = saveDraftCards(ws, { id: sourceId, courseId }, sectionId, [
      { unit: 2, kind: 'basic', front: ' What is osmosis? ', back: 'Water crossing a membrane' },
      { unit: 3, kind: 'cloze', front: 'Pumps use {{c1::ATP}}.', back: 'ignored' },
      { unit: 0, kind: 'basic', front: 'What is the deck about?', back: '' },
    ])
    expect(ws.cards.get(osmosis ?? '')).toMatchObject({ courseId, sectionId, sourceId, unit: 2, origin: 'ai' })
    expect(ws.text({ id: osmosis ?? '', field: 'front' }).toString()).toBe('What is osmosis?')
    expect(ws.text({ id: osmosis ?? '', field: 'back' }).toString()).toBe('Water crossing a membrane')
    expect(ws.cards.get(cloze ?? '')).toMatchObject({ kind: 'cloze', unit: 3 })
    expect(ws.text({ id: cloze ?? '', field: 'back' }).toString()).toBe('')
    // The whole source: nothing narrower to cite.
    expect(ws.cards.get(whole ?? '')?.unit).toBeUndefined()
  })
})
