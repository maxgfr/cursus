import { expect, test } from 'bun:test'
import * as Y from 'yjs'
import { createWorkspace } from '../../core/model/workspace'
import { virtualClock } from '../../core/ports/clock'
import { seededRng } from '../../core/ports/rng'
import { applyForward } from '../History/replay.ts'
import { mergeText, saveExisting } from './merge.ts'

function device(seed: number) {
  const doc = new Y.Doc()
  const clock = virtualClock(1_000)
  return { doc, w: createWorkspace(doc, { rng: seededRng(seed, clock), clock, deviceId: `dev${seed}` }) }
}

function sync(a: Y.Doc, b: Y.Doc) {
  const ua = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b))
  const ub = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a))
  Y.applyUpdateV2(b, ua)
  Y.applyUpdateV2(a, ub)
}

/** Device A opens card X; device B edits it; the edit syncs to A before A saves its draft. */
function twoDevices() {
  const a = device(1)
  const b = device(2)
  const course = a.w.courses.create({ title: 'Bio' })
  const id = a.w.batch(() => {
    const id = a.w.cards.create({ courseId: course, kind: 'basic' })
    a.w.text({ id, field: 'front' }).insert(0, 'Powerhouse of the cell?')
    a.w.text({ id, field: 'back' }).insert(0, 'The mitochondrion')
    return id
  })
  sync(a.doc, b.doc)
  const base = { kind: 'basic' as const, front: 'Powerhouse of the cell?', back: 'The mitochondrion' }
  return { a, b, id, base }
}

test('the old Save (every field rebuilt from the draft) loses a remote edit to an untouched field', () => {
  const { a, b, id, base } = twoDevices()
  applyForward(b.w.text({ id, field: 'front' }), 'Powerhouse of the eukaryotic cell?')
  sync(a.doc, b.doc)
  const draft = { ...base, back: 'The mitochondria' }
  applyForward(a.w.text({ id, field: 'front' }), draft.front)
  applyForward(a.w.text({ id, field: 'back' }), draft.back)
  expect(a.w.text({ id, field: 'front' }).toString()).toBe('Powerhouse of the cell?')
})

test('Save writes only the fields the draft changed: a remote edit to another field survives', () => {
  const { a, b, id, base } = twoDevices()
  applyForward(b.w.text({ id, field: 'front' }), 'Powerhouse of the eukaryotic cell?')
  b.w.cards.update(id, { kind: 'cloze' })
  sync(a.doc, b.doc)
  const conflicts = saveExisting(a.w, id, base, { ...base, back: 'The mitochondria' })
  sync(a.doc, b.doc)
  expect(conflicts).toEqual([])
  for (const w of [a.w, b.w]) {
    expect(w.text({ id, field: 'front' }).toString()).toBe('Powerhouse of the eukaryotic cell?')
    expect(w.text({ id, field: 'back' }).toString()).toBe('The mitochondria')
    expect(w.cards.get(id)?.kind).toBe('cloze')
  }
})

test('both sides changed one field: the local edit lands where its context still is', () => {
  const { a, b, id, base } = twoDevices()
  applyForward(b.w.text({ id, field: 'back' }), 'The mitochondrion (an organelle)')
  sync(a.doc, b.doc)
  const conflicts = saveExisting(a.w, id, base, { ...base, back: 'A mitochondrion' })
  expect(conflicts).toEqual([])
  expect(a.w.text({ id, field: 'back' }).toString()).toBe('A mitochondrion (an organelle)')
})

test('when the context is gone, the remote text stays and the field is reported', () => {
  const { a, b, id, base } = twoDevices()
  applyForward(b.w.text({ id, field: 'back' }), 'ATP factory')
  sync(a.doc, b.doc)
  const conflicts = saveExisting(a.w, id, base, { ...base, back: 'The mitochondria' })
  expect(conflicts).toEqual(['back'])
  expect(a.w.text({ id, field: 'back' }).toString()).toBe('ATP factory')
})

test('mergeText', () => {
  expect(mergeText('abc', 'abc', 'xyz')).toBe('xyz')
  expect(mergeText('abc', 'abX', 'abc')).toBe('abX')
  expect(mergeText('', 'new', 'remote')).toBeNull()
  expect(mergeText('one two', 'one 2', 'zero one two')).toBe('zero one 2')
  expect(mergeText('ab', 'ab!', 'ab ab')).toBeNull()
})
