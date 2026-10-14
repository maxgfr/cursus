import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import * as Y from 'yjs'
import type { Id } from '../contracts/workspace'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { EntityNotFoundError } from './repos'
import { SectionMoveError, SectionTree } from './sections'
import { createWorkspace, type ModelWorkspace } from './workspace'

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

/** Everything a device derives from the tree: effective parents, derived trash, where each item resolves. */
function signature(w: ModelWorkspace): string {
  const tree = w.sections.tree()
  const rows = tree
    .ids()
    .slice()
    .sort()
    .map((id) => `${id}<${tree.parent(id) ?? '-'}${tree.hidden(id) ? '!' : ''}`)
  for (const kind of ['sources', 'fiches', 'cards'] as const) {
    for (const e of w[kind].all()) rows.push(`${e.id}@${tree.sectionOf(e) ?? '-'}`)
  }
  return rows.sort().join('|')
}

/** The derived tree has no cycle and only links sections of the same course; items stay in their course. */
function checkTree(w: ModelWorkspace): void {
  const tree = w.sections.tree()
  const all = tree.ids()
  for (const id of all) {
    let cur: Id | null = id
    let steps = 0
    while (cur !== null) {
      const p: Id | null = tree.parent(cur)
      if (p !== null) expect(tree.get(p)?.courseId).toBe(tree.get(cur)?.courseId as Id)
      cur = p
      steps++
      expect(steps).toBeLessThanOrEqual(all.length)
    }
  }
  for (const kind of ['sources', 'fiches', 'cards'] as const) {
    for (const e of w[kind].all()) {
      const s = tree.sectionOf(e)
      if (s !== null) expect(tree.get(s)?.courseId).toBe(e.courseId)
    }
  }
}

describe('sections', () => {
  test('nothing is written at startup or by any read', () => {
    const { doc, w } = make(1)
    const c = w.courses.create({ title: 'Law' })
    const s = w.sections.create({ courseId: c, name: 'Contracts' })
    const card = w.cards.create({ courseId: c, kind: 'basic' })
    const before = Y.encodeStateVector(doc)
    let updates = 0
    doc.on('update', () => updates++)
    w.sections.tree()
    w.sections.path(s)
    w.sections.subtree(s)
    w.sections.children(c, null)
    w.scoped('cards', { courseId: c, sectionId: s })
    w.exams()
    w.search.search('contracts')
    expect(w.cards.get(card)?.sectionId).toBeUndefined()
    expect(updates).toBe(0)
    expect(Y.encodeStateVector(doc)).toEqual(before)
  })

  test('nesting, path, subtree, sibling order and reordering', () => {
    const { w } = make(2)
    const c = w.courses.create({ title: 'Law' })
    const a = w.sections.create({ courseId: c, name: 'Contracts' })
    const b = w.sections.create({ courseId: c, name: 'Torts' })
    const a1 = w.sections.create({ courseId: c, parentId: a, name: 'Formation' })
    const a2 = w.sections.create({ courseId: c, parentId: a, name: 'Breach' })
    const a11 = w.sections.create({ courseId: c, parentId: a1, name: 'Offer' })
    expect(ids(w.sections.children(c, null))).toEqual([a, b])
    expect(ids(w.sections.children(c, a))).toEqual([a1, a2])
    expect(w.sections.path(a11).map((s) => s.name)).toEqual(['Contracts', 'Formation', 'Offer'])
    expect(w.sections.path('nope')).toEqual([])
    expect(w.sections.subtree(a)).toEqual([a, a1, a11, a2])
    expect(w.sections.subtree('nope')).toEqual([])
    w.sections.reorder(a2, a1)
    expect(ids(w.sections.children(c, a))).toEqual([a2, a1])
    w.sections.reorder(a2, null)
    expect(ids(w.sections.children(c, a))).toEqual([a1, a2])
    w.sections.reorder(b, a)
    expect(ids(w.sections.children(c, null))).toEqual([b, a])
    expect(() => w.sections.reorder(b, a11)).toThrow(SectionMoveError)
    expect(() => w.sections.reorder('nope', null)).toThrow(EntityNotFoundError)
  })

  test('reordering among siblings created at once with the same key', () => {
    const { w } = make(3)
    const c = w.courses.create({ title: 'C' })
    const x = w.sections.create({ courseId: c, name: 'x', order: 'a1' })
    const y = w.sections.create({ courseId: c, name: 'y', order: 'a1' })
    const z = w.sections.create({ courseId: c, name: 'z', order: 'a2' })
    const nokey = w.sections.create({ courseId: c, name: 'n' })
    w.sections.update(nokey, { order: undefined })
    // Siblings: nokey ('' sorts first), x, y (same key, by id), z.
    const [first, second] = [x, y].sort()
    w.sections.reorder(z, second as Id)
    const order = ids(w.sections.children(c, null))
    expect(order.indexOf(z)).toBeLessThan(order.indexOf(second as Id))
    expect(order.indexOf(z)).toBeLessThan(order.indexOf(first as Id))
    // Nothing sorts before a sibling without a key: the section lands right after it.
    w.sections.reorder(z, nokey)
    expect(ids(w.sections.children(c, null)).slice(0, 2)).toEqual([nokey, z])
    w.sections.reorder(x, null)
    expect(ids(w.sections.children(c, null)).at(-1)).toBe(x)
  })

  test('moves into its own subtree, another course or a missing section are refused locally', () => {
    const { w } = make(4)
    const c = w.courses.create({ title: 'C' })
    const other = w.courses.create({ title: 'O' })
    const a = w.sections.create({ courseId: c, name: 'a' })
    const b = w.sections.create({ courseId: c, parentId: a, name: 'b' })
    const o = w.sections.create({ courseId: other, name: 'o' })
    const reason = (fn: () => void): string => {
      try {
        fn()
      } catch (e) {
        if (e instanceof SectionMoveError) return e.reason
        throw e
      }
      return 'ok'
    }
    expect(reason(() => w.sections.move(a, a))).toBe('cycle')
    expect(reason(() => w.sections.move(a, b))).toBe('cycle')
    expect(reason(() => w.sections.update(a, { parentId: b }))).toBe('cycle')
    expect(reason(() => w.sections.move(a, o))).toBe('course')
    expect(reason(() => w.sections.update(a, { courseId: other }))).toBe('course')
    expect(reason(() => w.sections.create({ courseId: other, parentId: a, name: 'x' }))).toBe('course')
    expect(reason(() => w.sections.create({ courseId: c, parentId: 'ghost', name: 'x' }))).toBe('missing')
    w.sections.purge(o)
    expect(reason(() => w.sections.create({ courseId: other, parentId: o, name: 'x' }))).toBe('missing')
    expect(() => w.sections.move('ghost', null)).toThrow(EntityNotFoundError)
    expect(new SectionMoveError('cycle', 'a', 'b').message).toContain('cycle')
    // Allowed: back to the root, then under a former child.
    w.sections.move(b, null)
    w.sections.move(a, b)
    expect(ids(w.sections.path(a))).toEqual([b, a])
    w.sections.update(a, { courseId: c, name: 'renamed' })
    expect(w.sections.get(a)?.name).toBe('renamed')
  })

  test('A under B on one device and B under A on another: the same tree everywhere, smallest id at the root', () => {
    const one = make(5)
    const two = make(6)
    const c = one.w.courses.create({ title: 'C' })
    const a = one.w.sections.create({ courseId: c, name: 'A' })
    const b = one.w.sections.create({ courseId: c, name: 'B' })
    sync(one.doc, two.doc)
    one.w.sections.move(a, b)
    two.w.sections.move(b, a)
    sync(one.doc, two.doc)
    const before = Y.encodeStateVector(one.doc)
    const [small, big] = [a, b].sort() as [Id, Id]
    for (const x of [one, two]) {
      const tree = x.w.sections.tree()
      expect(tree.parent(small)).toBeNull()
      expect(tree.parent(big)).toBe(small)
      expect(ids(x.w.sections.children(c, null))).toEqual([small])
      checkTree(x.w)
    }
    expect(signature(one.w)).toBe(signature(two.w))
    // Resolved at read time, nothing written: the stored links still form the cycle.
    expect(Y.encodeStateVector(one.doc)).toEqual(before)
    expect(one.w.sections.get(small)?.parentId).toBe(big)
    // Moving the cycle's root under its child is still refused locally.
    expect(() => one.w.sections.move(small, big)).toThrow(SectionMoveError)
  })

  test('longer cycles, self links, purged parents and parents of another course resolve to the course root', () => {
    const recs = (rows: [Id, Id | undefined, string?][]) =>
      rows.map(([id, parentId, courseId]) => ({
        id,
        courseId: courseId ?? 'c',
        name: id,
        createdAt: 0,
        updatedAt: 0,
        ...(parentId === undefined ? {} : { parentId }),
        ...(id === 'p' ? { purgedAt: 1, deletedAt: 1 } : {}),
      }))
    const tree = new SectionTree(
      recs([
        ['x3', 'x1'],
        ['x1', 'x2'],
        ['x2', 'x3'],
        ['y', 'x2'],
        ['self', 'self'],
        ['p', undefined],
        ['orphan', 'p'],
        ['foreign', 'x1', 'other'],
        ['ghost', 'missing'],
      ]),
    )
    expect(tree.parent('x1')).toBeNull()
    expect(tree.parent('x2')).toBe('x3')
    expect(tree.parent('x3')).toBe('x1')
    expect(tree.parent('y')).toBe('x2')
    expect(tree.parent('self')).toBeNull()
    expect(tree.parent('orphan')).toBeNull()
    expect(tree.parent('foreign')).toBeNull()
    expect(tree.parent('ghost')).toBeNull()
    expect(tree.get('p')).toBeUndefined()
    expect(tree.chain('y').map((s) => s.id)).toEqual(['x1', 'x3', 'x2', 'y'])
    expect(tree.subtree('x1')).toEqual(['x1', 'x3', 'x2', 'y'])
    expect(tree.children('other', null).map((s) => s.id)).toEqual(['foreign'])
    expect(tree.hidden('p')).toBe(false)
    expect(tree.locate({ courseId: 'c', sectionId: 'p' })).toEqual([])
  })

  test('trash hides the subtree by derivation, restore brings it back, without any cascade write', () => {
    const { doc, w } = make(7)
    const c = w.courses.create({ title: 'Law' })
    const ch = w.sections.create({ courseId: c, name: 'Contracts' })
    const sub = w.sections.create({ courseId: c, parentId: ch, name: 'Formation' })
    const card = w.cards.create({ courseId: c, kind: 'basic', sectionId: sub })
    const free = w.cards.create({ courseId: c, kind: 'basic' })
    const src = w.sources.create({ courseId: c, kind: 'note', title: 'Offer notes', sectionId: ch })
    const fiche = w.fiches.create({ courseId: c, title: 'F', sectionId: sub })
    w.text({ id: src, field: 'body' }).insert(0, 'acceptance')
    expect(w.search.search('acceptance').map((h) => h.id)).toEqual([src])

    const subMap = doc.getMap<Y.Map<unknown>>('sections').get(sub)
    const cardMap = doc.getMap<Y.Map<unknown>>('cards').get(card)
    const untouched = [subMap?.toJSON(), cardMap?.toJSON()]
    w.sections.trash(ch)
    expect([subMap?.toJSON(), cardMap?.toJSON()]).toEqual(untouched)
    expect(ids(w.sections.list())).toEqual([])
    expect(ids(w.sections.list({ trashed: true }))).toEqual([ch])
    expect(w.sections.tree().hidden(sub)).toBe(true)
    expect(ids(w.cards.list())).toEqual([free])
    expect(ids(w.cards.list({ trashed: true }))).toEqual([])
    expect(w.sources.list()).toEqual([])
    expect(w.fiches.list()).toEqual([])
    expect(w.cards.get(card)?.id).toBe(card)
    expect(w.search.search('acceptance')).toEqual([])
    expect(ids(w.scoped('cards', { courseId: c }))).toEqual([free])
    expect(w.sections.children(c, null)).toEqual([])
    expect(ids(w.sections.tree().children(c, null, { trashed: true }))).toEqual([ch])

    w.sections.restore(ch)
    expect(ids(w.sections.list()).sort()).toEqual([ch, sub].sort())
    expect(ids(w.cards.list()).sort()).toEqual([card, free].sort())
    expect(ids(w.sources.list())).toEqual([src])
    expect(ids(w.fiches.list())).toEqual([fiche])
    expect(w.search.search('acceptance').map((h) => h.id)).toEqual([src])
  })

  test('a purged section lets its subtree and items fall back to the course root', () => {
    const { w } = make(8)
    const c = w.courses.create({ title: 'C' })
    const ch = w.sections.create({ courseId: c, name: 'Ch' })
    const sub = w.sections.create({ courseId: c, parentId: ch, name: 'Sub' })
    const card = w.cards.create({ courseId: c, kind: 'basic', sectionId: ch })
    w.sections.trash(ch)
    w.sections.purge(ch)
    expect(ids(w.sections.list())).toEqual([sub])
    expect(w.sections.tree().parent(sub)).toBeNull()
    expect(ids(w.cards.list())).toEqual([card])
    expect(w.sections.tree().sectionOf(w.cards.get(card) ?? { courseId: c })).toBeNull()
    expect(ids(w.scoped('cards', { courseId: c, sectionId: sub }))).toEqual([])
  })

  test('items: moveItem files them (their course follows), null takes them back to the root', () => {
    const { w } = make(9)
    const c1 = w.courses.create({ title: '1' })
    const c2 = w.courses.create({ title: '2' })
    const s1 = w.sections.create({ courseId: c1, name: 'S1' })
    const s2 = w.sections.create({ courseId: c2, name: 'S2' })
    const card = w.cards.create({ courseId: c1, kind: 'basic' })
    const src = w.sources.create({ courseId: c1, kind: 'note', title: 'n' })
    const fiche = w.fiches.create({ courseId: c1, title: 'f' })
    w.moveItem('cards', card, s1)
    w.moveItem('sources', src, s2)
    w.moveItem('fiches', fiche, s1)
    expect(w.cards.get(card)).toMatchObject({ courseId: c1, sectionId: s1 })
    expect(w.sources.get(src)).toMatchObject({ courseId: c2, sectionId: s2 })
    expect(ids(w.scoped('fiches', { courseId: c1, sectionId: s1 }))).toEqual([fiche])
    w.moveItem('cards', card, null)
    expect(w.cards.get(card)?.sectionId).toBeUndefined()
    expect(() => w.moveItem('cards', card, 'ghost')).toThrow(EntityNotFoundError)
    w.moveItem('cards', card, s1)
    w.cards.move(card, c2)
    expect(w.cards.get(card)).toEqual(expect.objectContaining({ courseId: c2 }))
    expect(w.cards.get(card)?.sectionId).toBeUndefined()
  })

  test('an item filed in a section of another course (concurrent moves) resolves to its own course root', () => {
    const one = make(10)
    const two = make(11)
    const c1 = one.w.courses.create({ title: '1' })
    const c2 = one.w.courses.create({ title: '2' })
    const s1 = one.w.sections.create({ courseId: c1, name: 'S1' })
    const card = one.w.cards.create({ courseId: c1, kind: 'basic' })
    sync(one.doc, two.doc)
    one.w.cards.update(card, { courseId: c2 })
    two.w.moveItem('cards', card, s1)
    sync(one.doc, two.doc)
    for (const x of [one, two]) {
      const e = x.w.cards.get(card)
      expect(e).toMatchObject({ courseId: c2, sectionId: s1 })
      expect(x.w.sections.tree().sectionOf(e ?? { courseId: c2 })).toBeNull()
      expect(ids(x.w.scoped('cards', { courseId: c2 }))).toEqual([card])
      expect(x.w.scoped('cards', { courseId: c1, sectionId: s1 })).toEqual([])
      checkTree(x.w)
    }
  })

  test('scope includes descendants; exams list each course first, then its visible subsets in tree order', () => {
    const { w } = make(12)
    const c = w.courses.create({ title: 'Law', examDate: '2026-12-01' })
    const quiet = w.courses.create({ title: 'Quiet' })
    const a = w.sections.create({ courseId: c, name: 'A', examDate: '2026-11-01' })
    const a1 = w.sections.create({ courseId: c, parentId: a, name: 'A1', examDate: '2026-10-20' })
    const b = w.sections.create({ courseId: c, name: 'B', examDate: '2026-10-25' })
    w.sections.create({ courseId: quiet, name: 'Q' })
    const inA1 = w.cards.create({ courseId: c, kind: 'basic', sectionId: a1 })
    const inB = w.cards.create({ courseId: c, kind: 'basic', sectionId: b })
    const atRoot = w.cards.create({ courseId: c, kind: 'basic' })
    expect(ids(w.scoped('cards', { courseId: c, sectionId: a }))).toEqual([inA1])
    expect(ids(w.scoped('cards', { courseId: c })).sort()).toEqual([inA1, inB, atRoot].sort())
    expect(w.exams()).toEqual([
      { scope: { courseId: c }, examDate: '2026-12-01' },
      { scope: { courseId: c, sectionId: a }, examDate: '2026-11-01' },
      { scope: { courseId: c, sectionId: a1 }, examDate: '2026-10-20' },
      { scope: { courseId: c, sectionId: b }, examDate: '2026-10-25' },
    ])
    w.sections.trash(a)
    expect(w.exams().map((e) => e.scope.sectionId)).toEqual([undefined, b])
  })

  test('search indexes the path, filters by subset and follows renames, moves and trash', () => {
    const { w } = make(13)
    const c = w.courses.create({ title: 'Law' })
    const ch = w.sections.create({ courseId: c, name: 'Contracts' })
    const sub = w.sections.create({ courseId: c, parentId: ch, name: 'Formation' })
    const other = w.sections.create({ courseId: c, name: 'Torts' })
    const card = w.cards.create({ courseId: c, kind: 'basic', sectionId: sub })
    const src = w.sources.create({ courseId: c, kind: 'note', title: 'Negligence', sectionId: other })
    w.text({ id: card, field: 'front' }).insert(0, 'What is an offer?')
    const hit = w.search.search('offer')[0]
    expect(hit).toMatchObject({ id: card, kind: 'cards', path: 'Contracts › Formation' })
    expect(w.search.search('contracts').map((h) => h.id)).toEqual([card])
    expect(w.search.search('offer', { sectionId: ch }).map((h) => h.id)).toEqual([card])
    expect(w.search.search('offer', { sectionId: other })).toEqual([])
    expect(w.search.search('negligence')[0]).toMatchObject({ id: src, path: 'Torts' })
    w.sections.update(ch, { name: 'Obligations' })
    expect(w.search.search('obligations').map((h) => h.id)).toEqual([card])
    expect(w.search.search('offer')[0]?.path).toBe('Obligations › Formation')
    w.sections.move(sub, other)
    expect(w.search.search('offer')[0]?.path).toBe('Torts › Formation')
    expect(w.search.search('offer', { sectionId: ch })).toEqual([])
    w.sections.trash(other)
    expect(w.search.search('offer')).toEqual([])
    expect(w.search.search('negligence')).toEqual([])
    w.sections.restore(other)
    expect(w.search.search('offer').map((h) => h.id)).toEqual([card])
    // At the course root: no path at all.
    w.moveItem('cards', card, null)
    expect(w.search.search('offer')[0]).not.toHaveProperty('path')
    expect(w.search.search('law').map((h) => h.id)).toEqual([c])
  })

  test('subscribe to sections', () => {
    const { w } = make(14)
    const c = w.courses.create({ title: 'C' })
    let hits = 0
    const off = w.subscribe('sections', () => hits++)
    const s = w.sections.create({ courseId: c, name: 'S' })
    w.sections.update(s, { name: 'T' })
    off()
    w.sections.update(s, { name: 'U' })
    expect(hits).toBe(2)
    let one = 0
    const offOne = w.subscribe({ id: s }, () => one++)
    w.sections.trash(s)
    offOne()
    expect(one).toBe(1)
  })
})

// ---- Property: concurrent edits of the tree on several devices ----

type Op =
  | { t: 'create'; dev: number; course: number; parent: number }
  | { t: 'move'; dev: number; target: number; parent: number }
  | { t: 'trash' | 'restore' | 'purge'; dev: number; target: number }
  | { t: 'item'; dev: number; kind: 0 | 1 | 2; course: number; parent: number }
  | { t: 'file'; dev: number; target: number; section: number }
  | { t: 'sync'; a: number; b: number }

const n = fc.noBias(fc.nat({ max: 30 }))
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('create' as const), dev: n, course: n, parent: n }) },
  { weight: 6, arbitrary: fc.record({ t: fc.constant('move' as const), dev: n, target: n, parent: n }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constantFrom('trash' as const, 'restore' as const, 'purge' as const),
      dev: n,
      target: n,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('item' as const),
      dev: n,
      kind: fc.constantFrom<0 | 1 | 2>(0, 1, 2),
      course: n,
      parent: n,
    }),
  },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('file' as const), dev: n, target: n, section: n }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('sync' as const), a: n, b: n }) },
)

const KINDS = ['sources', 'fiches', 'cards'] as const
const at = <T>(xs: readonly T[], i: number): T | undefined => (xs.length === 0 ? undefined : xs[i % xs.length])

function apply(devs: ReturnType<typeof make>[], op: Op, created: Set<Id>, items: Set<Id>): void {
  if (op.t === 'sync') {
    const a = at(devs, op.a)
    const b = at(devs, op.b)
    if (a && b && a !== b) sync(a.doc, b.doc)
    return
  }
  const { w } = at(devs, op.dev) as ReturnType<typeof make>
  const all = w.sections.all().filter((s) => s.purgedAt === undefined)
  const refused = (fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      if (!(e instanceof SectionMoveError)) throw e
    }
  }
  switch (op.t) {
    case 'create': {
      const course = at(w.courses.all(), op.course)?.id as Id
      const parent = at(
        all.filter((s) => s.courseId === course),
        op.parent,
      )
      const useParent = parent !== undefined && op.parent % 3 !== 0
      created.add(
        w.sections.create({
          courseId: course,
          name: `s${created.size}`,
          ...(useParent ? { parentId: parent.id } : {}),
        }),
      )
      return
    }
    case 'move': {
      const target = at(all, op.target)
      if (!target) return
      const parent = at(
        all.filter((s) => s.courseId === target.courseId),
        op.parent,
      )
      refused(() => w.sections.move(target.id, op.parent % 4 === 0 || !parent ? null : parent.id))
      return
    }
    case 'trash':
    case 'restore':
    case 'purge': {
      const target = at(all, op.target)
      if (target) w.sections[op.t](target.id)
      return
    }
    case 'item': {
      const kind = KINDS[op.kind]
      const course = at(w.courses.all(), op.course)?.id as Id
      const section = at(
        all.filter((s) => s.courseId === course),
        op.parent,
      )
      const sectionId = section?.id
      const id =
        kind === 'cards'
          ? w.cards.create({ courseId: course, kind: 'basic', sectionId })
          : kind === 'sources'
            ? w.sources.create({ courseId: course, kind: 'note', title: 't', sectionId })
            : w.fiches.create({ courseId: course, title: 't', sectionId })
      items.add(id)
      return
    }
    case 'file': {
      const every = KINDS.flatMap((k) => w[k].all().map((e) => ({ kind: k, id: e.id })))
      const item = at(every, op.target)
      if (!item) return
      const section = at(all, op.section)
      w.moveItem(item.kind, item.id, op.section % 4 === 0 || !section ? null : section.id)
      return
    }
  }
}

describe('sections under concurrent edits', () => {
  test('every device derives the same acyclic tree; nothing is lost; reads never write', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(opArb, { minLength: 1, maxLength: 60, size: 'max' }),
        (count, ops) => {
          const devs = Array.from({ length: count }, (_, i) => make(100 + i))
          const first = devs[0] as ReturnType<typeof make>
          const ca = first.w.courses.create({ title: 'A' })
          const cb = first.w.courses.create({ title: 'B' })
          const created = new Set<Id>()
          // Sections every device knows before going offline: concurrent moves of them can form cycles.
          for (let i = 0; i < 4; i++) created.add(first.w.sections.create({ courseId: ca, name: `a${i}` }))
          for (let i = 0; i < 2; i++) created.add(first.w.sections.create({ courseId: cb, name: `b${i}` }))
          for (const d of devs) sync(first.doc, d.doc)
          const items = new Set<Id>()
          for (const op of ops) apply(devs, op, created, items)
          // Each device on its own is consistent too, before converging.
          for (const d of devs) checkTree(d.w)
          for (let round = 0; round < 2; round++) for (const d of devs) sync(first.doc, d.doc)
          const ref = signature(first.w)
          for (const d of devs) {
            const sv = Y.encodeStateVector(d.doc)
            expect(signature(d.w)).toBe(ref)
            checkTree(d.w)
            const raw = d.doc.getMap<Y.Map<unknown>>('sections')
            for (const id of created) expect(raw.has(id)).toBe(true)
            for (const id of items) expect(KINDS.some((k) => d.w[k].get(id) !== undefined)).toBe(true)
            expect(Y.encodeStateVector(d.doc)).toEqual(sv)
          }
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 100) },
    )
  })
})

describe('inside one transaction', () => {
  test('course, parent, child and item created in one batch see each other', () => {
    const { w } = make(41)
    const out = w.batch(() => {
      const course = w.courses.create({ title: 'C' })
      const parent = w.sections.create({ courseId: course, name: 'P' })
      const child = w.sections.create({ courseId: course, parentId: parent, name: 'K' })
      const card = w.cards.create({ courseId: course, sectionId: child, kind: 'basic' })
      expect(w.sections.path(child).map((s) => s.name)).toEqual(['P', 'K'])
      expect(w.cards.get(card)?.sectionId).toBe(child)
      expect(w.sections.tree().pathOf({ courseId: course, sectionId: child })).toBe('P › K')
      w.sections.trash(parent)
      expect(w.sections.list({ courseId: course })).toHaveLength(0)
      w.sections.restore(parent)
      return { course, child, card }
    })
    expect(
      w.sections
        .tree()
        .contains({ courseId: out.course, sectionId: out.child }, w.cards.get(out.card) ?? { courseId: '' }),
    ).toBe(true)
  })

  test('a move into its own subtree is still refused mid-batch', () => {
    const { w } = make(42)
    w.batch(() => {
      const course = w.courses.create({ title: 'C' })
      const a = w.sections.create({ courseId: course, name: 'A' })
      const b = w.sections.create({ courseId: course, parentId: a, name: 'B' })
      expect(() => w.sections.move(a, b)).toThrow(SectionMoveError)
    })
  })
})

describe('atomic', () => {
  test('a throw undoes every write of the transaction and rethrows', () => {
    const { w } = make(43)
    const kept = w.courses.create({ title: 'Kept' })
    const boom = new Error('boom')
    expect(() =>
      w.atomic(() => {
        const course = w.courses.create({ title: 'C' })
        const parent = w.sections.create({ courseId: course, name: 'P' })
        w.sections.create({ courseId: course, parentId: parent, name: 'K' })
        const card = w.cards.create({ courseId: course, sectionId: parent, kind: 'basic' })
        w.text({ id: card, field: 'front' }).insert(0, 'q')
        w.reviews.record({ cardId: card, rating: 3, at: 1, ms: 1 })
        w.courses.update(kept, { title: 'Changed' })
        throw boom
      }),
    ).toThrow(boom)
    expect(w.courses.list().map((c) => c.title)).toEqual(['Kept'])
    expect(w.sections.list()).toHaveLength(0)
    expect(w.cards.list()).toHaveLength(0)
    expect(w.reviews.yArray.length).toBe(0)
    expect(w.atomic(() => w.sections.create({ courseId: kept, name: 'S' }))).toBe(w.sections.list()[0]?.id as string)
  })
})
