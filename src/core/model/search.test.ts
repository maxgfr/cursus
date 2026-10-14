import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { fold } from './search'
import { createWorkspace } from './workspace'

function make() {
  const doc = new Y.Doc()
  return createWorkspace(doc, { rng: seededRng(9), clock: virtualClock(), deviceId: 'd' })
}

describe('search', () => {
  test('fold strips accents', () => {
    expect(fold('Élève Größe')).toBe('eleve große')
  })

  test('indexes titles and texts with accent folding, updated per transaction', () => {
    const w = make()
    const c = w.courses.create({ title: 'Économie' })
    const s = w.sources.create({ courseId: c, kind: 'note', title: 'Notes' })
    expect(w.search.search('economie').map((h) => h.id)).toEqual([c])
    w.text({ id: s, field: 'body' }).insert(0, 'La photosynthèse des plantes')
    expect(w.search.search('photosynthese').map((h) => h.id)).toEqual([s])
    w.sources.trash(s)
    expect(w.search.search('photosynthese')).toEqual([])
    w.sources.restore(s)
    expect(w.search.search('photo', { kind: 'sources', courseId: c }).map((h) => h.id)).toEqual([s])
    w.sources.update(s, { title: 'Résumé' })
    expect(w.search.search('resume').map((h) => h.id)).toEqual([s])
  })

  test('index built from existing doc and remote updates', () => {
    const a = make()
    const c = a.courses.create({ title: 'Chimie' })
    const doc = new Y.Doc()
    Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(a.doc))
    const b = createWorkspace(doc, { rng: seededRng(1), clock: virtualClock(), deviceId: 'b' })
    expect(b.search.search('chimie').map((h) => h.id)).toEqual([c])
    const k = a.cards.create({ courseId: c, kind: 'basic' })
    a.text({ id: k, field: 'front' }).insert(0, 'molécule')
    Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(a.doc, Y.encodeStateVector(doc)))
    expect(b.search.search('molecule').map((h) => h.id)).toEqual([k])
  })
})
