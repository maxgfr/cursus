import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import * as Y from 'yjs'
import type { Id } from '../contracts/workspace'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { buildQueue } from '../srs/queue'
import { arrangeCards, CardOrderError, placeOf } from './cardOrder'
import { EntityNotFoundError } from './repos'
import { createWorkspace } from './workspace'

function make(seed: number) {
  const doc = new Y.Doc()
  const clock = virtualClock(1_000)
  return { doc, clock, w: createWorkspace(doc, { rng: seededRng(seed, clock), clock, deviceId: `d${seed}` }) }
}

function sync(a: Y.Doc, b: Y.Doc): void {
  const ua = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b))
  const ub = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a))
  Y.applyUpdateV2(b, ua)
  Y.applyUpdateV2(a, ub)
}

const ids = (xs: readonly { id: Id }[]): Id[] => xs.map((x) => x.id)

interface C {
  id: Id
  courseId: Id
  sectionId?: Id
  order?: string
}

const card = fc.record(
  {
    courseId: fc.constantFrom('c1', 'c2'),
    sectionId: fc.constantFrom('s1', 's2'),
    order: fc.constantFrom('a0', 'a1', 'a2', 'Zz', ''),
  },
  { requiredKeys: ['courseId'] },
)
const cards = fc
  .array(card, { maxLength: 30 })
  .map((xs): C[] => xs.map((x, i) => ({ id: `id${String(i).padStart(3, '0')}`, ...x })))

describe('arrangeCards', () => {
  test('a list without keys is kept as it is', () => {
    const list: C[] = [
      { id: 'a', courseId: 'c1' },
      { id: 'b', courseId: 'c2', sectionId: 's' },
      { id: 'c', courseId: 'c1' },
    ]
    expect(arrangeCards(list)).toEqual(list)
  })

  test('each place follows its keys in the positions its cards held, those without a key last', () => {
    const list: C[] = [
      { id: 'a', courseId: 'c1' },
      { id: 'b', courseId: 'c2' },
      { id: 'c', courseId: 'c1', order: 'a1' },
      { id: 'd', courseId: 'c1', order: 'a0' },
      { id: 'e', courseId: 'c2' },
    ]
    expect(ids(arrangeCards(list))).toEqual(['d', 'b', 'c', 'a', 'e'])
  })

  test('property: a permutation that keeps every place on its slots, in its own order', () => {
    fc.assert(
      fc.property(cards, (list) => {
        const out = arrangeCards(list)
        expect(ids(out).sort()).toEqual(ids(list).sort())
        // Slots: position i holds a card of the same place as before.
        expect(out.map(placeOf)).toEqual(list.map(placeOf))
        const key = (c: C) => (c.order ? c.order : null)
        for (let i = 1; i < out.length; i++) {
          const a = out
            .slice(0, i)
            .filter((x) => placeOf(x) === placeOf(out[i] as C))
            .at(-1)
          if (a === undefined) continue
          const b = out[i] as C
          const ka = key(a)
          const kb = key(b)
          if (ka !== null && kb !== null) expect(ka < kb || (ka === kb && a.id < b.id)).toBe(true)
          else if (ka === null) expect(kb === null && a.id < b.id).toBe(true)
        }
        if (list.every((c) => !c.order)) expect(out).toEqual(list)
      }),
      { numRuns: Number(process.env.FC_RUNS ?? 100) },
    )
  })
})

describe('cards.reorder', () => {
  test('orders the cards of a place, and only them', () => {
    const { w } = make(1)
    const c = w.courses.create({ title: 'Law' })
    const s = w.sections.create({ courseId: c, name: 'Contracts' })
    for (const sectionId of [s, undefined, s, undefined, s]) w.cards.create({ courseId: c, sectionId, kind: 'basic' })
    // Slots of each place in the list, which stays sorted by id until something is ordered by hand.
    const before = w.cards.list()
    const slots = before.map((k) => (k.sectionId === s ? 's' : 'r'))
    const [a, b, d] = before.filter((k) => k.sectionId === s).map((k) => k.id) as [Id, Id, Id]
    const root = before.filter((k) => k.sectionId !== s).map((k) => k.id)
    const shown = () => ids(w.scoped('cards', { courseId: c, sectionId: s }))
    w.cards.reorder(d, a)
    expect(shown()).toEqual([d, a, b])
    expect(w.cards.list().map((k) => (k.sectionId === s ? 's' : 'r'))).toEqual(slots)
    expect(ids(w.cards.list().filter((k) => k.sectionId !== s))).toEqual(root)
    // The first reorder gave the whole place keys; the root kept none.
    expect([a, b, d].every((k) => typeof w.cards.get(k)?.order === 'string')).toBe(true)
    expect(root.every((k) => w.cards.get(k)?.order === undefined)).toBe(true)
    w.cards.reorder(d, null)
    expect(shown()).toEqual([a, b, d])
    w.cards.reorder(b, a)
    expect(shown()).toEqual([b, a, d])
    // A card added later goes last in its place.
    const e = w.cards.create({ courseId: c, sectionId: s, kind: 'basic' })
    expect(shown()).toEqual([b, a, d, e])
  })

  test('once a place is keyed, a reorder writes only the moved card', () => {
    const { doc, w } = make(2)
    const c = w.courses.create({ title: 'C' })
    const [a, b, d] = [0, 1, 2].map(() => w.cards.create({ courseId: c, kind: 'basic' })) as Id[]
    w.cards.reorder(d as Id, a as Id)
    const keys = new Map(w.cards.list().map((k) => [k.id, k.order]))
    let writes = 0
    const off = (tr: Y.Transaction) => {
      writes += tr.changed.size
    }
    doc.on('afterTransaction', off)
    w.cards.reorder(a as Id, null)
    doc.off('afterTransaction', off)
    expect(writes).toBe(1)
    expect(w.cards.get(b as Id)?.order).toBe(keys.get(b as Id))
    expect(w.cards.get(d as Id)?.order).toBe(keys.get(d as Id))
    expect(ids(w.cards.list())).toEqual([d, b, a] as Id[])
  })

  test('refuses a card of another place or a missing card', () => {
    const { w } = make(3)
    const c = w.courses.create({ title: 'C' })
    const s = w.sections.create({ courseId: c, name: 's' })
    const a = w.cards.create({ courseId: c, kind: 'basic' })
    const b = w.cards.create({ courseId: c, sectionId: s, kind: 'basic' })
    expect(() => w.cards.reorder(a, b)).toThrow(CardOrderError)
    expect(() => w.cards.reorder('nope', null)).toThrow(EntityNotFoundError)
  })

  test('a card that changes place goes last there; staying put keeps its key', () => {
    const { w } = make(4)
    const c = w.courses.create({ title: 'C' })
    const other = w.courses.create({ title: 'O' })
    const s = w.sections.create({ courseId: c, name: 's' })
    const [a, b, d] = [0, 1, 2].map(() => w.cards.create({ courseId: c, sectionId: s, kind: 'basic' })) as Id[]
    w.cards.reorder(d as Id, a as Id)
    const key = w.cards.get(d as Id)?.order
    w.moveItem('cards', d as Id, s)
    expect(w.cards.get(d as Id)?.order).toBe(key as string)
    w.moveItem('cards', d as Id, null)
    expect(w.cards.get(d as Id)?.order).toBeUndefined()
    w.moveItem('cards', a as Id, null)
    expect(ids(w.cards.list({ courseId: c }).filter((k) => k.sectionId === undefined))).toEqual([a, d] as Id[])
    w.cards.move(b as Id, other)
    expect(w.cards.get(b as Id)?.order).toBeUndefined()
    expect(w.cards.get(b as Id)?.courseId).toBe(other)
  })

  test('two devices reordering the same place at once converge, with no card lost', () => {
    const one = make(5)
    const two = make(6)
    const c = one.w.courses.create({ title: 'C' })
    const list = [0, 1, 2, 3].map(() => one.w.cards.create({ courseId: c, kind: 'basic' }))
    sync(one.doc, two.doc)
    one.w.cards.reorder(list[3] as Id, list[0] as Id)
    two.w.cards.reorder(list[0] as Id, null)
    sync(one.doc, two.doc)
    expect(ids(one.w.cards.list())).toEqual(ids(two.w.cards.list()))
    expect(ids(one.w.cards.list()).sort()).toEqual([...list].sort())
    // Equal keys from the two first reorders are spread again by the next one.
    one.w.cards.reorder(list[1] as Id, list[2] as Id)
    const after = ids(one.w.cards.list())
    expect(after.indexOf(list[1] as Id)).toBe(after.indexOf(list[2] as Id) - 1)
  })

  test('new cards come in the order chosen by hand; shuffling still shuffles them', () => {
    const { w } = make(7)
    const c = w.courses.create({ title: 'C' })
    const list = [0, 1, 2, 3].map(() => w.cards.create({ courseId: c, kind: 'basic' }))
    w.cards.reorder(list[3] as Id, list[0] as Id)
    w.cards.reorder(list[2] as Id, list[3] as Id)
    const queue = (newOrder: 'created' | 'random') =>
      buildQueue({
        cards: w.cards.list().map((k) => ({ id: k.id, courseId: k.courseId })),
        states: new Map(),
        now: 10_000,
        tzOffsetMin: 0,
        newPerDay: 10,
        newOrder,
      }).map((q) => q.cardId)
    expect(queue('created')).toEqual([list[2], list[3], list[0], list[1]] as Id[])
    expect(queue('random').sort()).toEqual([...list].sort())
  })
})
