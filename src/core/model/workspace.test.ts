import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import type { Rating } from '../contracts/workspace'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { createWorkspace, TextNotFoundError } from './workspace'

function ws(seed: number, dev = `dev${seed}`) {
  const doc = new Y.Doc()
  const clock = virtualClock(1_000)
  return { doc, clock, w: createWorkspace(doc, { rng: seededRng(seed, clock), clock, deviceId: dev }) }
}

function sync(a: Y.Doc, b: Y.Doc) {
  const ua = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b))
  const ub = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a))
  Y.applyUpdateV2(b, ua)
  Y.applyUpdateV2(a, ub)
}

describe('workspace', () => {
  test('no writes at startup, reads included', async () => {
    const doc = new Y.Doc()
    let updates = 0
    doc.on('update', () => updates++)
    const w = createWorkspace(doc, { rng: seededRng(1), clock: virtualClock(), deviceId: 'd' })
    expect(w.courses.list()).toEqual([])
    expect(w.prefs.get('locale')).toBe('en')
    expect(w.prefs.get('dailyNewCards')).toBe(20)
    expect(w.reviews.forCard('x')).toEqual([])
    expect(await w.search.search('anything')).toEqual([])
    const off = w.subscribe('courses', () => {})
    off()
    expect(updates).toBe(0)
    expect(doc.share.size).toBeGreaterThan(0)
    expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(new Y.Doc()))
  })

  test('CRUD, trash, restore, purge without cascade', () => {
    const { w } = ws(2)
    const c = w.courses.create({ title: 'Bio', emoji: 'x' })
    const card = w.cards.create({ courseId: c, kind: 'basic' })
    expect(w.courses.get(c)?.title).toBe('Bio')
    expect(typeof w.courses.get(c)?.order).toBe('string')
    w.courses.trash(c)
    expect(w.courses.list()).toEqual([])
    expect(w.courses.list({ trashed: true }).map((x) => x.id)).toEqual([c])
    expect(w.cards.get(card)?.deletedAt).toBeUndefined()
    w.courses.restore(c)
    expect(w.courses.list().length).toBe(1)
    w.courses.purge(c)
    expect(w.courses.get(c)).toBeUndefined()
    expect(w.courses.list({ trashed: true })).toEqual([])
  })

  test('courses keep fractional order of creation', () => {
    const { w } = ws(3)
    const a = w.courses.create({ title: 'A' })
    const b = w.courses.create({ title: 'B' })
    const c = w.courses.create({ title: 'C' })
    expect(w.courses.list().map((x) => x.id)).toEqual([a, b, c])
  })

  test('snapshots are memoized', () => {
    const { w } = ws(4)
    const a = w.courses.create({ title: 'A' })
    const l1 = w.courses.list()
    expect(w.courses.list()).toBe(l1)
    const b = w.courses.create({ title: 'B' })
    const l2 = w.courses.list()
    expect(l2).not.toBe(l1)
    expect(l2.find((x) => x.id === a)).toBe(l1.find((x) => x.id === a))
    w.courses.update(b, { title: 'B2' })
    expect(w.courses.list().find((x) => x.id === a)).toBe(l1.find((x) => x.id === a))
  })

  test('texts exist from creation; unknown text throws', () => {
    const { w } = ws(5)
    const c = w.courses.create({ title: 'C' })
    const card = w.cards.create({ courseId: c, kind: 'basic' })
    w.text({ id: card, field: 'front' }).insert(0, 'Q')
    expect(w.text({ id: card, field: 'back' }).toString()).toBe('')
    expect(() => w.text({ id: c, field: 'body' })).toThrow(TextNotFoundError)
  })

  test('cards.move and subscribe by scope', () => {
    const { w } = ws(6)
    const c1 = w.courses.create({ title: '1' })
    const c2 = w.courses.create({ title: '2' })
    const card = w.cards.create({ courseId: c1, kind: 'basic' })
    let hits = 0
    const off = w.subscribe({ id: card }, () => hits++)
    w.cards.move(card, c2)
    w.text({ id: card, field: 'front' }).insert(0, 'x')
    off()
    w.cards.move(card, c1)
    expect(hits).toBe(2)
    expect(w.cards.list({ courseId: c1 }).map((x) => x.id)).toEqual([card])
  })

  test('batch is one transaction', () => {
    const { doc, w } = ws(7)
    let updates = 0
    doc.on('update', () => updates++)
    const id = w.batch(() => {
      const c = w.courses.create({ title: 'A' })
      w.courses.update(c, { color: 'red' })
      return c
    })
    expect(updates).toBe(1)
    expect(w.courses.get(id)?.color).toBe('red')
  })

  test('prefs written only on explicit set', () => {
    const { doc, w } = ws(8)
    let updates = 0
    doc.on('update', () => updates++)
    expect(w.prefs.get('theme')).toBe('system')
    w.prefs.set('theme', 'dark')
    expect(w.prefs.get('theme')).toBe('dark')
    expect(updates).toBe(1)
  })
})

describe('convergence', () => {
  test('concurrent edits on different fields and text merge', () => {
    const a = ws(10)
    const b = ws(11)
    const c = a.w.courses.create({ title: 'T' })
    const s = a.w.sources.create({ courseId: c, kind: 'note', title: 'N' })
    a.w.text({ id: s, field: 'body' }).insert(0, 'hello')
    sync(a.doc, b.doc)
    a.w.courses.update(c, { title: 'T2' })
    b.w.courses.update(c, { color: 'blue' })
    a.w.text({ id: s, field: 'body' }).insert(0, 'A ')
    b.w.text({ id: s, field: 'body' }).insert(5, ' B')
    sync(a.doc, b.doc)
    for (const x of [a, b]) {
      expect(x.w.courses.get(c)?.title).toBe('T2')
      expect(x.w.courses.get(c)?.color).toBe('blue')
      expect(x.w.text({ id: s, field: 'body' }).toString()).toBe('A hello B')
    }
  })

  test('trash against concurrent edit keeps the edit and the trash', () => {
    const a = ws(12)
    const b = ws(13)
    const c = a.w.courses.create({ title: 'T' })
    const card = a.w.cards.create({ courseId: c, kind: 'basic' })
    sync(a.doc, b.doc)
    a.w.cards.trash(card)
    b.w.text({ id: card, field: 'front' }).insert(0, 'edited')
    b.w.cards.update(card, { tags: ['x'] })
    sync(a.doc, b.doc)
    for (const x of [a, b]) {
      expect(x.w.cards.list({ trashed: true }).map((e) => e.id)).toEqual([card])
      expect(x.w.cards.get(card)?.tags).toEqual(['x'])
      expect(x.w.text({ id: card, field: 'front' }).toString()).toBe('edited')
    }
    b.w.cards.restore(card)
    sync(a.doc, b.doc)
    expect(a.w.cards.list().map((e) => e.id)).toEqual([card])
  })

  test('nested type race: concurrent creations then exchange lose nothing', () => {
    const a = ws(20)
    const b = ws(21)
    const ca = a.w.courses.create({ title: 'A' })
    const cb = b.w.courses.create({ title: 'B' })
    const ka = a.w.cards.create({ courseId: ca, kind: 'basic' })
    const kb = b.w.cards.create({ courseId: cb, kind: 'cloze' })
    const sa = a.w.sources.create({ courseId: ca, kind: 'note', title: 'sa' })
    const sb = b.w.sources.create({ courseId: cb, kind: 'pdf', title: 'sb' })
    a.w.text({ id: ka, field: 'front' }).insert(0, 'qa')
    a.w.text({ id: sa, field: 'body' }).insert(0, 'body a')
    b.w.text({ id: kb, field: 'back' }).insert(0, 'rb')
    b.w.text({ id: sb, field: 'body' }).insert(0, 'body b')
    a.w.prefs.set('theme', 'dark')
    b.w.prefs.set('locale', 'fr')
    sync(a.doc, b.doc)
    for (const x of [a, b]) {
      expect(new Set(x.w.courses.list().map((e) => e.id))).toEqual(new Set([ca, cb]))
      expect(x.w.cards.list().length).toBe(2)
      expect(x.w.text({ id: ka, field: 'front' }).toString()).toBe('qa')
      expect(x.w.text({ id: kb, field: 'back' }).toString()).toBe('rb')
      expect(x.w.text({ id: sa, field: 'body' }).toString()).toBe('body a')
      expect(x.w.text({ id: sb, field: 'body' }).toString()).toBe('body b')
      expect(x.w.prefs.get('theme')).toBe('dark')
      expect(x.w.prefs.get('locale')).toBe('fr')
    }
    expect(Y.encodeStateAsUpdateV2(a.doc)).toEqual(Y.encodeStateAsUpdateV2(b.doc))
  })

  test('reviews merge, voids apply across devices, replay order (at, id)', () => {
    const a = ws(30, 'A')
    const b = ws(31, 'B')
    const c = a.w.courses.create({ title: 'T' })
    const card = a.w.cards.create({ courseId: c, kind: 'basic' })
    sync(a.doc, b.doc)
    const r1 = a.w.reviews.record({ cardId: card, rating: 3, at: 200, ms: 1000 })
    const r2 = b.w.reviews.record({ cardId: card, rating: 1, at: 100, ms: -5 })
    const r3 = b.w.reviews.record({ cardId: card, rating: 4, at: 300, ms: 10 })
    sync(a.doc, b.doc)
    a.w.reviews.void(r3)
    sync(a.doc, b.doc)
    for (const x of [a, b]) {
      const list = x.w.reviews.forCard(card)
      expect(list.map((r) => r.id)).toEqual([r2, r1])
      const first = list[0]
      expect(first && 'ms' in first ? first.ms : -1).toBe(0)
      expect(first && 'dev' in first ? first.dev : '').toBe('B')
    }
  })
})

describe('bulk review history', () => {
  const fresh = () => {
    const clock = virtualClock(1)
    const doc = new Y.Doc({ gc: true })
    doc.clientID = 1
    return { doc, w: createWorkspace(doc, { rng: seededRng(5, clock), clock, deviceId: 'd' }) }
  }
  const history = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      cardId: `c${i % 7}`,
      rating: ((i % 4) + 1) as Rating,
      at: i * 1_000,
      ms: i % 3 === 0 ? -5 : 900,
    }))

  test('recordMany equals record one by one: same ids, order and encoded update', () => {
    const rs = history(2_000)
    const a = fresh()
    const ids = a.w.atomic(() => rs.map((r) => a.w.reviews.record(r)))
    const b = fresh()
    expect(b.w.atomic(() => b.w.reviews.recordMany(rs))).toEqual(ids)
    expect(b.w.reviews.yArray.toJSON()).toEqual(a.w.reviews.yArray.toJSON())
    expect(Y.encodeStateAsUpdateV2(b.doc)).toEqual(Y.encodeStateAsUpdateV2(a.doc))
    expect(b.w.reviews.forCard('c3')).toEqual(a.w.reviews.forCard('c3'))
    expect(b.w.reviews.recordMany([])).toEqual([])
  })

  test('50k reviews in one atomic transaction stay linear', () => {
    const rs = history(50_000)
    const { w } = fresh()
    const t0 = performance.now()
    w.atomic(() => w.reviews.recordMany(rs))
    // Per-item pushes took ~4.3 s here (quadratic); one push takes tens of ms.
    expect(performance.now() - t0).toBeLessThan(1_500)
    expect(w.reviews.yArray.length).toBe(50_000)
    expect(w.reviews.forCard('c0')).toHaveLength(Math.ceil(50_000 / 7))
  })

  test('forCard sees reviews recorded earlier in the same transaction', () => {
    const { w } = fresh()
    w.batch(() => {
      expect(w.reviews.forCard('c0')).toHaveLength(0)
      w.reviews.record({ cardId: 'c0', rating: 3, at: 1, ms: 1 })
      expect(w.reviews.forCard('c0')).toHaveLength(1)
    })
  })
})
