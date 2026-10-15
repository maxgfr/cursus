import { expect, test } from 'bun:test'
import * as Y from 'yjs'
import { REMOTE, shouldCapture } from '../log/origins'
import { seededRng } from '../ports/rng'
import { isEmptied, isLive, TEXT_MIN_CHARS, track } from './deletions'
import { applyForward } from './textForward'
import { createWorkspace } from './workspace'

function replica(seed: number, base?: Y.Doc) {
  const doc = new Y.Doc()
  doc.clientID = seed
  if (base) Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(base))
  const ws = createWorkspace(doc, { rng: seededRng(seed), clock: { now: () => 1000 }, deviceId: `dev${seed}` })
  return { doc, ws }
}

/** A library of every guarded kind, and a copy of it elsewhere. */
function setup() {
  const here = replica(1)
  const ws = here.ws
  const courseId = ws.courses.create({ title: 'Biology' })
  const sectionId = ws.sections.create({ courseId, name: 'Cells' })
  const sourceId = ws.sources.create({ courseId, kind: 'note', title: 'Lecture' })
  ws.text({ id: sourceId, field: 'body' }).insert(0, 'b'.repeat(TEXT_MIN_CHARS * 2))
  const ficheId = ws.fiches.create({ courseId, title: 'Summary' })
  const cards = [0, 1, 2].map((i) => {
    const id = ws.cards.create({ courseId, kind: 'basic' })
    ws.text({ id, field: 'front' }).insert(0, `Front ${i}\nmore`)
    return id
  })
  const there = replica(2, here.doc)
  return { here, there, courseId, sectionId, sourceId, ficheId, cards }
}

/** What `there` did since it was copied, as one update. */
function changesOf(there: { doc: Y.Doc }, edit: () => void): Uint8Array {
  const sv = Y.encodeStateVector(there.doc)
  edit()
  return Y.encodeStateAsUpdateV2(there.doc, sv)
}

test('isLive and isEmptied', () => {
  const doc = new Y.Doc()
  const m = doc.getMap<Y.Map<unknown>>('x')
  const e = new Y.Map<unknown>()
  m.set('e', e)
  expect(isLive(e)).toBe(true)
  e.set('deletedAt', 1)
  expect(isLive(e)).toBe(false)
  expect(isLive(undefined)).toBe(false)
  expect(isEmptied(TEXT_MIN_CHARS, TEXT_MIN_CHARS * 0.2)).toBe(true)
  expect(isEmptied(TEXT_MIN_CHARS, TEXT_MIN_CHARS * 0.2 + 1)).toBe(false)
  expect(isEmptied(TEXT_MIN_CHARS - 1, 0)).toBe(false)
})

test('preview counts by kind with titles, and leaves the library untouched', () => {
  const { here, there, courseId, sectionId, sourceId, ficheId, cards } = setup()
  const update = changesOf(there, () => {
    there.ws.batch(() => {
      there.ws.sections.trash(sectionId)
      there.ws.fiches.purge(ficheId)
      there.ws.cards.trash(cards[0] ?? '')
      there.ws.courses.update(courseId, { title: 'Renamed' })
      const body = there.ws.text({ id: sourceId, field: 'body' })
      body.delete(0, body.length)
    })
  })
  const before = JSON.stringify(here.doc.toJSON())
  const report = here.ws.previewRemote([update])
  expect(JSON.stringify(here.doc.toJSON())).toBe(before)
  expect(report.counts).toEqual({ courses: 0, sections: 1, sources: 0, fiches: 1, cards: 1, texts: 1 })
  expect(report.total).toBe(4)
  expect(report.entities.map((e) => [e.kind, e.title])).toEqual([
    ['sections', 'Cells'],
    ['fiches', 'Summary'],
    ['cards', 'Front 0'],
  ])
  expect(report.texts).toEqual([{ key: `${sourceId}/body`, before: 'b'.repeat(TEXT_MIN_CHARS * 2) }])
})

test('apply: the held updates land as remote changes, never captured', () => {
  const { here, there, cards } = setup()
  const update = changesOf(there, () => there.ws.cards.trash(cards[1] ?? ''))
  const origins: unknown[] = []
  here.doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
  const report = here.ws.absorbHeld([update], 'apply')
  expect(report.counts.cards).toBe(1)
  expect(here.ws.cards.list().length).toBe(2)
  expect(origins).toEqual([REMOTE])
  expect(origins.some(shouldCapture)).toBe(false)
})

test('keep: everything deleted is back, removed maps and texts included, as one local edit', () => {
  const { here, there, courseId, sourceId, cards } = setup()
  const update = changesOf(there, () => {
    there.doc.transact(() => {
      there.doc.getMap('cards').delete(cards[2] ?? '')
      there.doc.getMap('texts').delete(`${sourceId}/body`)
      there.ws.courses.purge(courseId)
    })
  })
  const shown = JSON.stringify({ courses: here.ws.courses.list(), cards: here.ws.cards.list() })
  const origins: unknown[] = []
  here.doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
  const report = here.ws.absorbHeld([update], 'keep')
  expect(report.counts).toMatchObject({ courses: 1, cards: 1, texts: 1 })
  expect(origins).toEqual([REMOTE, null])
  expect(JSON.stringify({ courses: here.ws.courses.list(), cards: here.ws.cards.list() })).toBe(shown)
  expect(here.ws.text({ id: sourceId, field: 'body' }).toString()).toBe('b'.repeat(TEXT_MIN_CHARS * 2))
  // The restoration reaches the other replica as an ordinary update.
  Y.applyUpdateV2(there.doc, Y.encodeStateAsUpdateV2(here.doc))
  expect(there.ws.courses.list().map((c) => c.title)).toEqual(['Biology'])
  expect(there.ws.cards.list().length).toBe(3)
  expect(there.ws.text({ id: sourceId, field: 'body' }).length).toBe(TEXT_MIN_CHARS * 2)
})

test('keep with nothing deleted writes nothing', () => {
  const { here, there, courseId } = setup()
  const update = changesOf(there, () => there.ws.courses.update(courseId, { title: 'New' }))
  const origins: unknown[] = []
  here.doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
  expect(here.ws.absorbHeld([update], 'keep').total).toBe(0)
  expect(origins).toEqual([REMOTE])
  expect(here.ws.courses.list()[0]?.title).toBe('New')
})

test('track sees what a transaction touched, and stops listening after', () => {
  const doc = new Y.Doc()
  const cards = doc.getMap<Y.Map<unknown>>('cards')
  const touched = track(doc, () => {
    const m = new Y.Map<unknown>()
    cards.set('c1', m)
    doc.getMap('texts').set('c1/front', new Y.Text('x'))
    doc.getMap('prefs').set('theme', 'dark')
  })
  expect([...touched.entities.keys()]).toEqual(['cards/c1'])
  expect([...touched.texts]).toEqual(['c1/front'])
  const again = track(doc, () => {
    cards.get('c1')?.set('deletedAt', 1)
    ;(doc.getMap('texts').get('c1/front') as Y.Text).insert(0, 'y')
  })
  expect([...again.entities.keys()]).toEqual(['cards/c1'])
  expect([...again.texts]).toEqual(['c1/front'])
  expect(() =>
    track(doc, () => {
      throw new Error('boom')
    }),
  ).toThrow('boom')
})

test('applyForward rewrites only the differing span', () => {
  const doc = new Y.Doc()
  const t = doc.getText('t')
  t.insert(0, 'hello world')
  applyForward(t, 'hello brave world')
  expect(t.toString()).toBe('hello brave world')
  applyForward(t, 'hello brave world')
  applyForward(t, 'hello')
  expect(t.toString()).toBe('hello')
})
