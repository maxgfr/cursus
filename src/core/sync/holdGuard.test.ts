import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { encode } from '../log/codec'
import { createLocalLog } from '../log/localLog'
import { REPLAY } from '../log/origins'
import { TEXT_MIN_CHARS } from '../model/deletions'
import { createWorkspace } from '../model/workspace'
import { memoryLocks } from '../ports/locks'
import { seededRng } from '../ports/rng'
import { device, type TestDevice, world } from './harness.test'
import {
  type Effect,
  HOLD_AT_COUNT,
  HOLD_KV,
  HOLD_WINDOW_MS,
  type HoldBook,
  type HoldEvent,
  judge,
  Shadow,
} from './holdGuard'
import { FULL_LISTING_EVERY_MS } from './listing'
import { canonicalJson } from './verify'

const HOUR = 60 * 60 * 1000

/** A course with `n` cards, each with a front. */
function library(d: TestDevice, n: number, title = 'Bio'): { courseId: string; cards: string[] } {
  const courseId = d.ws.courses.create({ title })
  const cards: string[] = []
  for (let i = 0; i < n; i++) {
    const id = d.ws.cards.create({ courseId, kind: 'basic' })
    d.ws.text({ id, field: 'front' }).insert(0, `Question ${i}`)
    cards.push(id)
  }
  return { courseId, cards }
}

/** Two devices with the guard, sharing destination d1, B holding A's library. */
async function pair(n: number) {
  const w = world()
  const a = await device(1, w.clock, { holdDeletions: true })
  const b = await device(2, w.clock, { holdDeletions: true })
  const d1 = a.engine.addDest({ remote: w.remote('d1') })
  b.engine.addDest({ remote: w.remote('d1') })
  const lib = library(a, n)
  await a.commit()
  await a.engine.round(d1)
  await b.engine.round(d1)
  expect(b.ws.cards.list().length).toBe(n)
  return { w, a, b, d1, ...lib }
}

/** The user's choice on B: the held segments go through the Workspace, then the engine marks them applied. */
async function decide(d: TestDevice, mode: 'apply' | 'keep') {
  const held = await d.engine.held()
  const report = d.ws.absorbHeld(
    held.map((h) => h.update),
    mode,
  )
  await d.engine.release(held.map((h) => h.key))
  await d.commit()
  return report
}

/** The library as the persisted log alone rebuilds it (a reload). */
async function reloaded(d: TestDevice) {
  const doc = new Y.Doc()
  for (const u of (await d.log.load()).updates) Y.applyUpdateV2(doc, u, REPLAY)
  return createWorkspace(doc, { rng: seededRng(77), clock: { now: () => 0 }, deviceId: 'reload' })
}

const sameContent = (x: Y.Doc, y: Y.Doc): void => expect(canonicalJson(x)).toBe(canonicalJson(y))

describe('a destination that loses everything deletes nothing here', () => {
  test('a whole destination emptied: local log, files and library intact, everything uploaded again', async () => {
    const w = world()
    const a = await device(1, w.clock, { holdDeletions: true })
    const b = await device(2, w.clock, { holdDeletions: true })
    const id = a.engine.addDest({ remote: w.remote('d1') })
    b.engine.addDest({ remote: w.remote('d1') })
    const blob = await a.attach(new Uint8Array([1, 2, 3, 4]))
    library(a, 12)
    await a.commit()
    await a.engine.round(id)
    await b.engine.round(id)
    const remote = w.bucket.keys('d1/')
    const local = [...(await a.log.keys())].sort()
    const content = canonicalJson(a.doc)
    expect(remote.length).toBeGreaterThan(4)

    for (const k of remote) w.bucket.remove(k)
    w.clock.advance(FULL_LISTING_EVERY_MS)
    await b.engine.round(id) // B notices first: it re-uploads what it holds
    for (const k of w.bucket.keys('d1/')) w.bucket.remove(k)
    await a.engine.round(id)

    expect([...(await a.log.keys())].sort()).toEqual(local)
    expect(canonicalJson(a.doc)).toBe(content)
    expect(canonicalJson(b.doc)).toBe(content)
    expect((await reloaded(a)).cards.list().length).toBe(12)
    expect(await a.blobs.get(blob)).not.toBeNull()
    expect(await b.blobs.get(blob)).not.toBeNull()
    expect(w.bucket.keys('d1/')).toEqual(remote)
    expect(a.engine.status()).toMatchObject({ safe: true, held: 0 })
    expect(await a.engine.held()).toEqual([])
  })
})

describe('deletions from another device', () => {
  test('a small deletion applies as before', async () => {
    const { a, b, d1, cards } = await pair(30)
    for (const id of cards.slice(0, 3)) a.ws.cards.trash(id)
    await a.commit()
    await a.engine.round(d1)
    await b.engine.round(d1)
    expect(b.ws.cards.list().length).toBe(27)
    expect(await b.engine.held()).toEqual([])
    sameContent(a.doc, b.doc)
  })

  test('a mass deletion is held: not live, not loaded, not in since(), not checkpointed, not relayed', async () => {
    const { w, a, b, d1, cards } = await pair(30)
    const d2 = b.engine.addDest({ remote: w.remote('d2') })
    await b.engine.round(d2)
    a.ws.batch(() => {
      for (const id of cards.slice(0, 25)) a.ws.cards.trash(id)
    })
    await a.commit()
    await a.engine.round(d1)
    const r = await b.engine.round(d1)
    expect(r.down).toBe(1)

    expect(b.ws.cards.list().length).toBe(30)
    const held = await b.engine.held()
    expect(held.length).toBe(1)
    const [h] = held
    if (!h) throw new Error('one held segment expected')
    expect(h.deviceId).toBe(await a.log.deviceId())
    expect(h.heldAt).toBe(w.clock.now())
    expect(b.engine.status().held).toBe(1)
    expect((await reloaded(b)).cards.list().length).toBe(30)
    expect((await b.log.since(0)).map((s) => s.rec.key)).not.toContain(h.key)

    const ckpt = await b.engine.checkpoint()
    expect(ckpt).not.toBeNull()
    const covers = (await b.log.since(0)).find((s) => s.rec.key === ckpt)?.rec.header.covers ?? []
    expect(covers.length).toBeGreaterThan(0)
    expect(covers).not.toContain(h.key)

    await b.engine.round(d2)
    expect(w.bucket.keys('d2/').some((k) => k.endsWith(h.key))).toBe(false)
    expect(w.bucket.keys('d2/').some((k) => k.endsWith(ckpt ?? '?'))).toBe(true)
    // Listed on d1, it stays confirmed there: nothing downloads again, and nothing loops.
    expect((await b.engine.round(d1)).down).toBe(0)
    expect(await b.engine.round(d1)).toEqual({ down: 0, up: 0, deferred: 0 })
    // Not counted as unprotected anywhere: it is not this device's to relay.
    expect(b.engine.status().dests.map((d) => d.unconfirmed)).toEqual([0, 0])
    expect(b.ws.cards.list().length).toBe(30)
  })

  test('the same deletion split over many small segments is held once the total crosses the threshold', async () => {
    const { a, b, d1, cards } = await pair(60)
    for (const id of cards.slice(0, 25)) {
      a.ws.cards.trash(id)
      await a.commit()
    }
    await a.engine.round(d1)
    await b.engine.round(d1)
    // The first HOLD_AT_COUNT - 1 apply; the one reaching HOLD_AT_COUNT, and every later one, are held.
    expect(b.ws.cards.list().length).toBe(60 - (HOLD_AT_COUNT - 1))
    expect((await b.engine.held()).length).toBe(25 - (HOLD_AT_COUNT - 1))
  })

  test('half of a small library is held, over several rounds too', async () => {
    const { a, b, d1, cards } = await pair(6) // 7 entities with the course
    for (const id of cards.slice(0, 3)) a.ws.cards.trash(id)
    await a.commit()
    await a.engine.round(d1)
    await b.engine.round(d1)
    expect(b.ws.cards.list().length).toBe(3) // 3 of 7: below half, applied
    a.ws.cards.trash(cards[3] ?? '')
    await a.commit()
    await a.engine.round(d1)
    await b.engine.round(d1)
    expect(b.ws.cards.list().length).toBe(3) // 4 of 7 within the window: held
    expect((await b.engine.held()).length).toBe(1)
  })

  test('deletions further apart than the window do not add up', async () => {
    const { w, a, b, d1, cards } = await pair(60)
    a.ws.batch(() => {
      for (const id of cards.slice(0, 15)) a.ws.cards.trash(id)
    })
    await a.commit()
    await a.engine.round(d1)
    await b.engine.round(d1)
    w.clock.advance(HOLD_WINDOW_MS + HOUR)
    a.ws.batch(() => {
      for (const id of cards.slice(15, 30)) a.ws.cards.trash(id)
    })
    await a.commit()
    await a.engine.round(d1)
    await b.engine.round(d1)
    expect(b.ws.cards.list().length).toBe(30)
    expect(await b.engine.held()).toEqual([])
    const book = await b.store.read(['kv'], (tx) => tx.get<HoldBook>('kv', HOLD_KV))
    expect(book?.[await a.log.deviceId()]?.events.length).toBe(1)
  })

  test('once a device is held, everything it sends is held until the user decides', async () => {
    const { a, b, d1, cards, courseId } = await pair(30)
    a.ws.batch(() => {
      for (const id of cards.slice(0, 25)) a.ws.cards.trash(id)
    })
    await a.commit()
    a.ws.cards.create({ courseId, kind: 'basic' })
    await a.commit()
    await a.engine.round(d1)
    await b.engine.round(d1)
    expect(b.ws.cards.list().length).toBe(30)
    expect((await b.engine.held()).length).toBe(2)
    await decide(b, 'apply')
    expect(b.ws.cards.list().length).toBe(6)
  })

  test('a device syncing for the first time takes the library as it is', async () => {
    const w = world()
    const a = await device(1, w.clock, { holdDeletions: true })
    const id = a.engine.addDest({ remote: w.remote('d1') })
    const { cards } = library(a, 30)
    await a.commit()
    a.ws.batch(() => {
      for (const c of cards.slice(0, 25)) a.ws.cards.trash(c)
    })
    await a.commit()
    await a.engine.round(id)
    const fresh = await device(3, w.clock, { holdDeletions: true })
    fresh.engine.addDest({ remote: w.remote('d1') })
    await fresh.engine.round(id)
    expect(fresh.ws.cards.list().length).toBe(5)
    expect(await fresh.engine.held()).toEqual([])
  })

  test('without a live doc, the guard judges against the persisted library', async () => {
    const { w, a, d1, cards } = await pair(30)
    const store = (await device(4, w.clock)).store
    const headless = await device(4, w.clock, { store, holdDeletions: true, doc: undefined })
    headless.engine.addDest({ remote: w.remote('d1') })
    await headless.engine.round(d1)
    a.ws.batch(() => {
      for (const id of cards.slice(0, 25)) a.ws.cards.trash(id)
    })
    await a.commit()
    await a.engine.round(d1)
    await headless.engine.round(d1)
    expect((await headless.engine.held()).length).toBe(1)
    expect((await reloaded(headless)).cards.list().length).toBe(30)
  })
})

describe('forged objects', () => {
  test('a forged plaintext segment that purges and removes everything is held; keeping restores it all', async () => {
    const { w, a, b, d1 } = await pair(30)
    const forged = new Y.Doc()
    Y.applyUpdateV2(forged, Y.encodeStateAsUpdateV2(b.doc))
    const sv = Y.encodeStateVector(forged)
    forged.transact(() => {
      for (const [, m] of forged.getMap<Y.Map<unknown>>('courses')) m.set('purgedAt', 1)
      const cardsRoot = forged.getMap<Y.Map<unknown>>('cards')
      for (const id of [...cardsRoot.keys()]) cardsRoot.delete(id)
      const texts = forged.getMap<Y.Text>('texts')
      for (const [, t] of texts) t.delete(0, t.length)
    })
    const update = Y.encodeStateAsUpdateV2(forged, sv)
    const { key, bytes } = encode(
      { v: 1, kind: 'seg', deviceId: 'mallory', seq: 0, createdAt: 1, blobRefs: [] },
      update,
    )
    await w.remote('d1').put(key, bytes)
    const content = canonicalJson(b.doc)
    await b.engine.round(d1)
    expect(canonicalJson(b.doc)).toBe(content)
    expect((await b.engine.held()).map((h) => h.deviceId)).toEqual(['mallory'])

    const preview = b.ws.previewRemote((await b.engine.held()).map((h) => h.update))
    expect(preview.counts).toMatchObject({ courses: 1, cards: 30 })
    expect(canonicalJson(b.doc)).toBe(content)

    const report = await decide(b, 'keep')
    expect(report.total).toBe(31)
    expect(b.ws.courses.list().map((c) => c.title)).toEqual(['Bio'])
    expect(b.ws.cards.list().length).toBe(30)
    expect(b.ws.cards.list().every((c) => c.courseId === b.ws.courses.list()[0]?.id)).toBe(true)
    // The restoration is a local edit: it syncs out and repairs A, which applied nothing forged.
    await b.engine.round(d1)
    await a.engine.round(d1)
    sameContent(a.doc, b.doc)
    expect(a.ws.cards.list().length).toBe(30)
  })
})

describe('deletions spread across many devices', () => {
  /** A forged segment from `deviceId`, written straight to the bucket: it trashes `ids` in B's library. */
  async function forge(w: ReturnType<typeof world>, b: TestDevice, deviceId: string, ids: string[], clientID: number) {
    const forged = new Y.Doc()
    forged.clientID = clientID
    Y.applyUpdateV2(forged, Y.encodeStateAsUpdateV2(b.doc))
    const sv = Y.encodeStateVector(forged)
    forged.transact(() => {
      for (const id of ids) forged.getMap<Y.Map<unknown>>('cards').get(id)?.set('deletedAt', 1)
    })
    const { key, bytes } = encode(
      { v: 1, kind: 'seg', deviceId, seq: 0, createdAt: 1, blobRefs: [] },
      Y.encodeStateAsUpdateV2(forged, sv),
    )
    await w.remote('d1').put(key, bytes)
  }

  const bookOf = async (d: TestDevice): Promise<HoldBook> =>
    (await d.store.read(['kv'], (tx) => tx.get<HoldBook>('kv', HOLD_KV))) ?? {}

  test('a deletion split across 25 forged device ids, one card each, is held once the total crosses', async () => {
    const { w, a, b, d1, cards, courseId } = await pair(60)
    // A third, legitimate device that only adds.
    const c = await device(3, w.clock, { holdDeletions: true })
    c.engine.addDest({ remote: w.remote('d1') })
    await c.engine.round(d1)
    const ids = Array.from({ length: 25 }, (_, i) => `forged${String(i).padStart(2, '0')}`)
    for (const [i, id] of ids.entries()) await forge(w, b, id, [cards[i] ?? ''], 1000 + i)
    await b.engine.round(d1)
    // Each device is far below its own threshold; together they cross it at the HOLD_AT_COUNT-th.
    expect(b.ws.cards.list().length).toBe(60 - (HOLD_AT_COUNT - 1))
    const held = await b.engine.held()
    expect(held.length).toBe(25 - (HOLD_AT_COUNT - 1))
    expect(new Set(held.map((h) => h.deviceId)).size).toBe(held.length)
    const book = await bookOf(b)
    expect(ids.every((id) => book[id]?.holding === true)).toBe(true)

    // Ordinary edits from devices that delete nothing keep applying.
    const fresh = c.ws.cards.create({ courseId, kind: 'basic' })
    c.ws.text({ id: fresh, field: 'front' }).insert(0, 'New on C')
    await c.commit()
    await c.engine.round(d1)
    a.ws.courses.update(courseId, { title: 'Botany' })
    await a.commit()
    await a.engine.round(d1)
    await b.engine.round(d1)
    expect(b.ws.cards.get(fresh)).toBeDefined()
    expect(b.ws.courses.get(courseId)?.title).toBe('Botany')
    expect((await b.engine.held()).length).toBe(held.length)

    // Keeping the data restarts every window, the aggregate one included.
    await decide(b, 'keep')
    expect(b.ws.cards.list().length).toBe(60 - (HOLD_AT_COUNT - 1) + 1)
    expect(await bookOf(b)).toEqual({})
    a.ws.batch(() => {
      for (const id of cards.slice(30, 40)) a.ws.cards.trash(id)
    })
    await a.commit()
    await a.engine.round(d1)
    await b.engine.round(d1)
    expect(await b.engine.held()).toEqual([])
  })

  test('release keeps a device held whose segments arrived after the user looked', async () => {
    const { w, b, d1, cards } = await pair(30)
    for (const [i, id] of ['x1', 'x2', 'x3'].entries()) await forge(w, b, id, cards.slice(i * 10, i * 10 + 10), 50 + i)
    await b.engine.round(d1)
    const held = await b.engine.held()
    expect(held.map((h) => h.deviceId)).toEqual(['x2', 'x3'])
    b.ws.absorbHeld([held[0]?.update ?? new Uint8Array()], 'keep')
    await b.engine.release([held[0]?.key ?? ''])
    expect(await bookOf(b)).toEqual({ x3: { events: [], holding: true } })
    expect((await b.engine.held()).map((h) => h.deviceId)).toEqual(['x3'])
  })
})

describe('the user decides', () => {
  async function heldPair() {
    const p = await pair(30)
    p.a.ws.batch(() => {
      for (const id of p.cards.slice(0, 25)) p.a.ws.cards.trash(id)
    })
    await p.a.commit()
    await p.a.engine.round(p.d1)
    await p.b.engine.round(p.d1)
    expect((await p.b.engine.held()).length).toBe(1)
    return p
  }

  test('apply the deletions: B converges with A, and relays what it held', async () => {
    const { w, a, b, d1 } = await heldPair()
    const d2 = b.engine.addDest({ remote: w.remote('d2') })
    const report = await decide(b, 'apply')
    expect(report.counts.cards).toBe(25)
    expect(b.ws.cards.list().length).toBe(5)
    expect(b.engine.status().held).toBe(0)
    expect((await reloaded(b)).cards.list().length).toBe(5)
    await b.engine.round(d1)
    await a.engine.round(d1)
    sameContent(a.doc, b.doc)
    await b.engine.round(d2)
    const relayed = new Set(w.bucket.keys('d2/').map((k) => k.slice(3)))
    for (const k of await b.log.keys()) expect(relayed.has(k)).toBe(true)
  })

  test('keep my data: nothing changes here, and A gets its cards back after syncing', async () => {
    const { a, b, d1, cards } = await heldPair()
    const content = canonicalJson(b.doc)
    const report = await decide(b, 'keep')
    expect(report.counts.cards).toBe(25)
    expect(b.ws.cards.list().length).toBe(30)
    expect(b.ws.cards.list({ trashed: true })).toEqual([])
    expect(b.ws.text({ id: cards[0] ?? '', field: 'front' }).toString()).toBe('Question 0')
    expect(canonicalJson(b.doc)).toBe(content) // nothing visible changed here…
    expect((await reloaded(b)).cards.list().length).toBe(30) // …and the restoration is persisted
    await b.engine.round(d1)
    await a.engine.round(d1)
    expect(a.ws.cards.list().length).toBe(30)
    sameContent(a.doc, b.doc)
    // The window restarted: A's next small deletion applies again.
    a.ws.batch(() => {
      for (const id of cards.slice(0, 10)) a.ws.cards.trash(id)
    })
    await a.commit()
    await a.engine.round(d1)
    await b.engine.round(d1)
    expect(b.ws.cards.list().length).toBe(20)
  })

  test('emptied texts are held, then brought back to their content', async () => {
    const { a, b, d1 } = await pair(0)
    const courseId = a.ws.courses.list()[0]?.id ?? ''
    const body = 'x'.repeat(TEXT_MIN_CHARS + 300)
    const sources = [0, 1, 2, 3].map((i) => {
      const id = a.ws.sources.create({ courseId, kind: 'note', title: `Note ${i}` })
      a.ws.text({ id, field: 'body' }).insert(0, body)
      return id
    })
    await a.commit()
    await a.engine.round(d1)
    await b.engine.round(d1)
    for (const id of sources.slice(0, 3)) {
      const t = a.ws.text({ id, field: 'body' })
      t.delete(0, t.length - 10)
    }
    await a.commit()
    await a.engine.round(d1)
    await b.engine.round(d1)
    expect(b.ws.text({ id: sources[0] ?? '', field: 'body' }).length).toBe(body.length)
    const report = await decide(b, 'keep')
    expect(report.counts.texts).toBe(3)
    expect(report.texts.map((t) => t.before)).toEqual([body, body, body])
    for (const id of sources) expect(b.ws.text({ id, field: 'body' }).toString()).toBe(body)
    await b.engine.round(d1)
    await a.engine.round(d1)
    for (const id of sources) expect(a.ws.text({ id, field: 'body' }).toString()).toBe(body)
  })

  test('the held state survives a reload', async () => {
    const { w, b, d1 } = await heldPair()
    const again = await device(9, w.clock, { store: b.store, holdDeletions: true })
    again.engine.addDest({ remote: w.remote('d1') })
    expect(again.ws.cards.list().length).toBe(30)
    expect((await again.engine.held()).length).toBe(1)
    expect((await again.engine.refresh()).held).toBe(1)
    await again.engine.round(d1)
    expect(again.ws.cards.list().length).toBe(30)
    const log = createLocalLog({ store: b.store, locks: memoryLocks(), clock: w.clock, rng: seededRng(5) })
    expect((await log.held()).length).toBe(1)
  })
})

describe('judge', () => {
  const none: Effect = { deleted: [], texts: [], liveBefore: 100 }
  const ev = (at: number, deleted: string[]): HoldEvent => ({ at, deleted, shrunk: {}, emptied: [] })

  test('nothing deleted: nothing written', () => {
    expect(judge({}, 'd', none, 0)).toEqual({ hold: false, next: null })
    expect(judge({ d: { events: [] } }, 'd', { ...none, texts: [{ key: 't', before: 10, after: 900 }] }, 0)).toEqual({
      hold: false,
      next: null,
    })
    // Short texts shortened are not recorded.
    expect(judge({}, 'd', { ...none, texts: [{ key: 't', before: 50, after: 0 }] }, 0).next).toBeNull()
  })

  test('a held device stays held', () => {
    expect(judge({ d: { events: [], holding: true } }, 'd', none, 0)).toEqual({ hold: true, next: null })
  })

  test('a text shortened bit by bit is emptied against its length when the window opened', () => {
    let book: HoldBook = {}
    const lengths = [1000, 700, 400, 150]
    for (let i = 1; i < lengths.length; i++) {
      const out = judge(
        book,
        'd',
        { ...none, texts: [{ key: 't', before: lengths[i - 1] ?? 0, after: lengths[i] ?? 0 }] },
        i,
      )
      book = out.next ?? book
    }
    // 700 → 400 is not recorded: the text was already known, and not emptied yet.
    expect(book.d?.events.map((e) => [e.at, e.emptied])).toEqual([
      [1, []],
      [3, ['t']],
    ])
    expect(book.d?.events[0]?.shrunk).toEqual({ t: 1000 })
    expect(book.d?.events[1]?.shrunk).toEqual({})
  })

  test('events older than the window drop out, for every device', () => {
    const old: HoldBook = { d: { events: [ev(0, ['cards/x', 'cards/y'])] }, other: { events: [ev(0, ['cards/w'])] } }
    const out = judge(old, 'd', { ...none, deleted: ['cards/z'] }, HOLD_WINDOW_MS + 1)
    expect(out).toEqual({ hold: false, next: { d: { events: [ev(HOLD_WINDOW_MS + 1, ['cards/z'])] } } })
  })

  test('the count rule and the share rule', () => {
    const many = Array.from({ length: HOLD_AT_COUNT }, (_, i) => `cards/${i}`)
    expect(judge({}, 'd', { ...none, deleted: many, liveBefore: 1000 }, 0).hold).toBe(true)
    expect(judge({}, 'd', { ...none, deleted: many.slice(1), liveBefore: 1000 }, 0).hold).toBe(false)
    expect(judge({}, 'd', { deleted: ['a', 'b'], texts: [], liveBefore: 4 }, 0).hold).toBe(false) // library < 5
    expect(judge({}, 'd', { deleted: ['a', 'b', 'c'], texts: [], liveBefore: 6 }, 0).hold).toBe(true)
  })

  test('the aggregate of all devices holds every device that deleted within the window, not the others', () => {
    const book: HoldBook = {
      ...Object.fromEntries(
        Array.from({ length: HOLD_AT_COUNT - 1 }, (_, i) => [`f${i}`, { events: [ev(1, [`cards/${i}`])] }]),
      ),
      quiet: { events: [{ at: 1, deleted: [], shrunk: { t: 300 }, emptied: [] }] },
    }
    const out = judge(book, 'last', { ...none, deleted: ['cards/last'], liveBefore: 1000 }, 2)
    expect(out.hold).toBe(true)
    const next = out.next ?? {}
    expect(next.last?.holding).toBe(true)
    expect(next.f0?.holding).toBe(true)
    expect(next.quiet?.holding).toBeUndefined()
    expect(Object.values(next).filter((d) => d.holding).length).toBe(HOLD_AT_COUNT)
    // Below the aggregate threshold, nobody is held.
    expect(
      judge({ f0: book.f0 ?? { events: [] } }, 'last', { ...none, deleted: ['cards/last'], liveBefore: 1000 }, 2).hold,
    ).toBe(false)
  })
})

describe('Shadow', () => {
  test('counts live entities and text lengths, and what an update deletes', () => {
    const doc = new Y.Doc()
    const ws = createWorkspace(doc, { rng: seededRng(3), clock: { now: () => 1 }, deviceId: 'd' })
    const courseId = ws.courses.create({ title: 'c' })
    const card = ws.cards.create({ courseId, kind: 'basic' })
    ws.text({ id: card, field: 'front' }).insert(0, 'hello')
    const shadow = new Shadow(doc)
    expect(shadow.empty).toBe(false)
    const sv = Y.encodeStateVector(doc)
    ws.batch(() => {
      ws.cards.purge(card)
      ws.text({ id: card, field: 'front' }).delete(0, 5)
      ws.courses.create({ title: 'new' })
    })
    const effect = shadow.effectOf(Y.encodeStateAsUpdateV2(doc, sv))
    expect(effect).toEqual({
      deleted: [`cards/${card}`],
      texts: [{ key: `${card}/front`, before: 5, after: 0 }],
      liveBefore: 2,
    })
    expect(new Shadow(new Y.Doc()).empty).toBe(true)
    shadow.destroy()
  })
})
