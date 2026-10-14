import { expect, test } from 'bun:test'
import * as Y from 'yjs'
import { createWorkspace } from '../../core/model/workspace'
import { virtualClock } from '../../core/ports/clock'
import { seededRng } from '../../core/ports/rng'
import { purgeSection, trashedSections } from './sections.ts'

function library() {
  const clock = virtualClock(1_000)
  const ws = createWorkspace(new Y.Doc(), { rng: seededRng(5, clock), clock, deviceId: 'dev' })
  const law = ws.courses.create({ title: 'Law' })
  const contracts = ws.sections.create({ courseId: law, name: 'Contracts' })
  const formation = ws.sections.create({ courseId: law, parentId: contracts, name: 'Formation' })
  const a = ws.cards.create({ courseId: law, sectionId: contracts, kind: 'basic' })
  const b = ws.cards.create({ courseId: law, sectionId: formation, kind: 'basic' })
  const root = ws.cards.create({ courseId: law, kind: 'basic' })
  return { ws, contracts, formation, a, b, root }
}

test('a trashed subset is listed with its path and what it contains', () => {
  const { ws, contracts } = library()
  expect(trashedSections(ws)).toEqual([])
  ws.sections.trash(contracts)
  const [t, ...rest] = trashedSections(ws)
  expect(rest).toEqual([])
  expect(t).toMatchObject({ path: 'Law › Contracts', contents: { sections: 1, cards: 2, sources: 0, fiches: 0 } })
})

test('delete forever removes the subset and everything still filed in it, nothing else', () => {
  const { ws, contracts, formation, a, b, root } = library()
  ws.sections.trash(contracts)
  const [t] = trashedSections(ws)
  if (!t) throw new Error('not listed')
  purgeSection(ws, t)
  expect(trashedSections(ws)).toEqual([])
  expect(ws.sections.get(contracts)).toBeUndefined()
  expect(ws.sections.get(formation)).toBeUndefined()
  expect(ws.cards.get(a)).toBeUndefined()
  expect(ws.cards.get(b)).toBeUndefined()
  // Never resurfacing at the course root once its subset is gone.
  expect(ws.cards.list().map((c) => c.id)).toEqual([root])
})
