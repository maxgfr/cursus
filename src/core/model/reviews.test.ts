import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import type { NewReview, Review } from '../contracts/workspace'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { InvalidReviewError } from './reviewCodec'
import { ReviewLog, reviewEvents } from './reviews'
import { ROOT } from './schema'
import { createWorkspace } from './workspace'

function device(seed: number) {
  const doc = new Y.Doc()
  doc.clientID = seed
  const clock = virtualClock(1_000)
  const rng = seededRng(seed, clock)
  return { doc, log: new ReviewLog(doc, rng, `dev${seed}`), legacy: doc.getArray<Review>(ROOT.reviews) }
}

function sync(a: Y.Doc, b: Y.Doc) {
  const ua = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b))
  const ub = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a))
  Y.applyUpdateV2(b, ua)
  Y.applyUpdateV2(a, ub)
}

const ids = (rs: readonly Review[]) => rs.map((r) => r.id)

/** A review written by an earlier version of the app, straight into the legacy array. */
const old = (id: string, cardId: string, at: number): Review => ({ id, cardId, rating: 3, at, ms: 1_000, dev: 'old' })

describe('review log: legacy array and compact log', () => {
  test('writes only the compact form, one string per event', () => {
    const { doc, log, legacy } = device(1)
    const r1 = log.record({ cardId: 'c1', rating: 3, at: 10, ms: 900, sid: 's1', p: true })
    log.recordMany([
      { cardId: 'c2', rating: 1, at: 20, ms: -4 },
      { cardId: 'c1', rating: 4, at: 30, ms: 1 },
    ])
    log.void(r1)
    expect(legacy.length).toBe(0)
    const compact = doc.getArray<unknown>(ROOT.reviewLog).toArray()
    expect(compact).toHaveLength(4)
    for (const s of compact) expect(typeof s).toBe('string')
    expect(log.yArray.length).toBe(4)
    expect(log.yArray.toArray()[0]).toEqual({
      id: r1,
      cardId: 'c1',
      rating: 3,
      at: 10,
      ms: 900,
      dev: 'dev1',
      sid: 's1',
      p: true,
    })
    expect(log.yArray.toArray()[1]).toMatchObject({ cardId: 'c2', ms: 0 })
    expect(log.yArray.toJSON()).toEqual(log.yArray.toArray())
  })

  test('reads the legacy reviews alongside the compact ones, in one replay order', () => {
    const { log, legacy } = device(2)
    legacy.push([old('o1', 'c1', 50), { ...old('o2', 'c1', 5), sid: 'S', p: true }, old('o3', 'c2', 7)])
    const n1 = log.record({ cardId: 'c1', rating: 2, at: 20, ms: 1 })
    const n2 = log.record({ cardId: 'c2', rating: 2, at: 1, ms: 1, sid: 'S' })
    expect(ids(log.forCard('c1'))).toEqual(['o2', n1, 'o1'])
    expect(ids(log.forCard('c2'))).toEqual([n2, 'o3'])
    expect(ids(log.all())).toEqual([n2, 'o2', 'o3', n1, 'o1'])
    expect(ids(log.forSession('S'))).toEqual([n2, 'o2'])
    expect(log.forSession('S')[1]).toMatchObject({ sid: 'S', p: true, dev: 'old' })
    expect(ids(log.yArray.toArray())).toEqual(['o1', 'o2', 'o3', n1, n2])
  })

  test('voids apply across both forms, whichever wrote the void', () => {
    const { doc, log, legacy } = device(3)
    legacy.push([old('o1', 'c1', 1), old('o2', 'c1', 2)])
    const n1 = log.record({ cardId: 'c1', rating: 3, at: 3, ms: 1 })
    const n2 = log.record({ cardId: 'c1', rating: 3, at: 4, ms: 1 })
    expect(ids(log.forCard('c1'))).toEqual(['o1', 'o2', n1, n2])
    log.void('o1')
    // An earlier version voiding a review written in the compact form.
    legacy.push([{ id: 'ov', voids: n1 }])
    expect(ids(log.forCard('c1'))).toEqual(['o2', n2])
    expect(ids(log.all())).toEqual(['o2', n2])
    expect(reviewEvents(doc)).toEqual(log.yArray.toArray())
  })

  test('devices on either version append concurrently and converge', () => {
    const a = device(4)
    const b = device(5)
    const c = device(6)
    const first = a.log.record({ cardId: 'c1', rating: 3, at: 1, ms: 1 })
    sync(a.doc, b.doc)
    sync(b.doc, c.doc)
    expect(b.log.all()).toHaveLength(1)
    // Concurrent: a and b append compact events, c (an earlier version) appends to the legacy array.
    const ra = a.log.record({ cardId: 'c1', rating: 1, at: 2, ms: 1 })
    const rb = b.log.recordMany([
      { cardId: 'c1', rating: 4, at: 3, ms: 1 },
      { cardId: 'c2', rating: 4, at: 3, ms: 1 },
    ])
    c.legacy.push([old('oc', 'c1', 4)])
    b.log.void(ra)
    sync(a.doc, b.doc)
    sync(b.doc, c.doc)
    sync(a.doc, b.doc)
    for (const d of [a, b, c]) {
      expect(ids(d.log.forCard('c1'))).toEqual([first, rb[0] as string, 'oc'])
      expect(ids(d.log.forCard('c2'))).toEqual([rb[1] as string])
      expect(d.log.yArray.length).toBe(6)
      expect(ids(d.log.all())).toEqual(ids(a.log.all()))
    }
  })

  test('events read before a concurrent merge are re-read in their merged order', () => {
    const a = device(8)
    const b = device(7)
    a.log.record({ cardId: 'c1', rating: 3, at: 1, ms: 1 })
    sync(a.doc, b.doc)
    expect(a.log.yArray.length).toBe(1)
    b.log.record({ cardId: 'c1', rating: 3, at: 2, ms: 1 })
    a.log.record({ cardId: 'c1', rating: 3, at: 3, ms: 1 })
    expect(a.log.yArray.length).toBe(2)
    sync(a.doc, b.doc)
    // Whatever the merged order, a log built from scratch over the same doc reads the same events.
    for (const d of [a, b]) {
      const fresh = new ReviewLog(d.doc, seededRng(99), 'x')
      expect(d.log.yArray.toArray()).toEqual(fresh.yArray.toArray())
      expect(d.log.all()).toEqual(fresh.all())
    }
    expect(a.log.yArray.toArray()).toEqual(b.log.yArray.toArray())
  })

  test('an undone write leaves no event behind', () => {
    const doc = new Y.Doc()
    const w = createWorkspace(doc, { rng: seededRng(9), clock: virtualClock(), deviceId: 'd' })
    const kept = w.reviews.record({ cardId: 'c1', rating: 3, at: 1, ms: 1 })
    expect(w.reviews.all()).toHaveLength(1)
    expect(() =>
      w.atomic(() => {
        w.reviews.record({ cardId: 'c1', rating: 3, at: 2, ms: 1 })
        expect(w.reviews.all()).toHaveLength(2)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(ids(w.reviews.all())).toEqual([kept])
    expect(w.reviews.yArray.length).toBe(1)
  })

  test('subscribers to reviews hear both forms', () => {
    const doc = new Y.Doc()
    const w = createWorkspace(doc, { rng: seededRng(10), clock: virtualClock(), deviceId: 'd' })
    let heard = 0
    const off = w.subscribe('reviews', () => heard++)
    w.reviews.record({ cardId: 'c1', rating: 3, at: 1, ms: 1 })
    doc.getArray<Review>(ROOT.reviews).push([old('o1', 'c1', 2)])
    expect(heard).toBe(2)
    off()
    w.reviews.record({ cardId: 'c1', rating: 3, at: 3, ms: 1 })
    expect(heard).toBe(2)
    expect(w.reviews.forCard('c1')).toHaveLength(3)
  })

  test('sid and p survive a round trip through another doc', () => {
    const a = device(11)
    const b = device(12)
    a.log.record({ cardId: 'c1', rating: 2, at: 1, ms: 1, sid: 's', p: true })
    a.log.record({ cardId: 'c1', rating: 2, at: 2, ms: 1, sid: 's' })
    a.log.record({ cardId: 'c1', rating: 2, at: 3, ms: 1 })
    sync(a.doc, b.doc)
    const back = b.log.forCard('c1')
    expect(back).toEqual(a.log.forCard('c1'))
    expect(back.map((r) => ('sid' in r ? r.sid : undefined))).toEqual(['s', 's', undefined])
    expect(back.map((r) => ('p' in r ? r.p : undefined))).toEqual([true, undefined, undefined])
  })

  // Decided behaviour (changed): a garbled event used to throw on every read, on every device, forever, since
  // nothing caught the error; one bad synced value stopped Today, Review and Stats everywhere. It is now
  // quarantined: left out of every read, kept in the doc (never rewritten nor deleted) and reported.
  test('a garbled event is quarantined: kept in the doc, left out of every read, reported', () => {
    const { doc, log } = device(13)
    const good1 = log.record({ cardId: 'c1', rating: 3, at: 1, ms: 1 })
    expect(log.all()).toHaveLength(1)
    const compact = doc.getArray<unknown>(ROOT.reviewLog)
    compact.push(['[1,"r9","c1",3,'])
    const good2 = log.record({ cardId: 'c1', rating: 3, at: 2, ms: 1 })
    expect(ids(log.all())).toEqual([good1, good2])
    expect(ids(log.forCard('c1'))).toEqual([good1, good2])
    expect(log.forSession('s')).toEqual([])
    expect(log.yArray.length).toBe(2)
    expect(log.quarantined()).toEqual([
      { log: 'compact', index: 1, kind: 'malformed', reason: expect.stringContaining('review log event 1') },
    ])
    // Never dropped from the doc: the string is still there, for a later version (or a repair) to read.
    expect(compact.length).toBe(3)
    expect(compact.get(1)).toBe('[1,"r9","c1",3,')
    // Synced as is: another device reads the same good events and reports the same quarantined one.
    const other = device(20)
    sync(doc, other.doc)
    expect(ids(other.log.forCard('c1'))).toEqual([good1, good2])
    expect(other.log.quarantined()).toHaveLength(1)
    // A later format (a newer version of the app wrote it) is quarantined too, as a version problem.
    const { doc: doc2, log: log2 } = device(14)
    doc2.getArray<unknown>(ROOT.reviewLog).push(['[9,"future"]'])
    expect(log2.all()).toEqual([])
    expect(log2.quarantined()).toEqual([{ log: 'compact', index: 0, kind: 'version', reason: expect.any(String) }])
    expect(reviewEvents(doc2)).toEqual([])
  })

  test('a corrupt .apkg-like event (rating NaN, written as null) cannot stop the schedule once synced', () => {
    // What an earlier build wrote for a revlog row with ease 'x': the rating became null in the tuple.
    const { doc, log } = device(15)
    const kept = log.record({ cardId: 'c1', rating: 3, at: 1, ms: 1 })
    doc.getArray<unknown>(ROOT.reviewLog).push(['[1,"bad","c1",null,2,0,"dev"]'])
    const w = createWorkspace(doc, { rng: seededRng(16), clock: virtualClock(), deviceId: 'd' })
    expect(ids(w.reviews.forCard('c1'))).toEqual([kept])
    expect(w.reviews.quarantined()).toMatchObject([{ log: 'compact', index: 1, kind: 'malformed' }])
  })

  test('an unreadable legacy event is quarantined the same way', () => {
    const { legacy, log } = device(17)
    legacy.push([old('o1', 'c1', 1), { ...old('o2', 'c1', 2), rating: Number.NaN as 3 }, old('o3', 'c1', 3)])
    expect(ids(log.forCard('c1'))).toEqual(['o1', 'o3'])
    expect(log.quarantined()).toMatchObject([{ log: 'legacy', index: 1, kind: 'malformed' }])
    expect(legacy.length).toBe(3)
  })

  test('a legacy review whose answer time is not a number still counts, with no time', () => {
    // What an earlier build wrote for an Anki row whose time was not a number: the review itself was sound.
    const { legacy, log } = device(19)
    legacy.push([old('o1', 'c1', 1), { ...old('o2', 'c1', 2), ms: Number.NaN }])
    expect(ids(log.forCard('c1'))).toEqual(['o1', 'o2'])
    expect(log.forCard('c1')[1]).toMatchObject({ id: 'o2', ms: 0 })
    expect(log.quarantined()).toEqual([])
  })

  test('voids of a quarantined event, and events appended after it, read as usual', () => {
    const { doc, log } = device(18)
    doc.getArray<unknown>(ROOT.reviewLog).push(['not json'])
    const r = log.record({ cardId: 'c1', rating: 2, at: 5, ms: 1 })
    log.void('r-unknown')
    expect(ids(log.all())).toEqual([r])
    log.void(r)
    expect(log.all()).toEqual([])
    expect(log.quarantined()).toHaveLength(1)
  })
})

describe('review log: the write boundary', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['a rating that is not a number (an .apkg ease of "x")', { rating: Number.NaN }],
    ['a rating out of range', { rating: 5 }],
    ['a fractional rating', { rating: 2.5 }],
    ['a rating given as a string', { rating: '3' }],
    ['a time that is not finite', { at: Number.NaN }],
    ['an infinite time', { at: Number.POSITIVE_INFINITY }],
    ['an answer time that is not a number', { ms: Number.NaN }],
    ['an empty card id', { cardId: '' }],
    ['a numeric card id', { cardId: 7 }],
    ['an empty session id', { sid: '' }],
  ]
  for (const [name, patch] of bad)
    test(`refuses ${name}, writing nothing`, () => {
      const { doc, log } = device(30)
      const review = { cardId: 'c1', rating: 3, at: 10, ms: 1, ...patch } as unknown as NewReview
      expect(() => log.record(review)).toThrow(InvalidReviewError)
      // One bad review in a batch: none of it is written.
      expect(() => log.recordMany([{ cardId: 'c1', rating: 3, at: 1, ms: 1 }, review])).toThrow(
        expect.objectContaining({ name: 'InvalidReviewError', index: 1 }),
      )
      expect(doc.getArray<unknown>(ROOT.reviewLog).length).toBe(0)
      expect(log.all()).toEqual([])
    })

  test('refuses a void without a target', () => {
    const { doc, log } = device(31)
    expect(() => log.void('')).toThrow(InvalidReviewError)
    expect(doc.getArray<unknown>(ROOT.reviewLog).length).toBe(0)
  })

  test('a negative answer time is still clamped to 0, not refused', () => {
    const { log } = device(32)
    log.record({ cardId: 'c1', rating: 3, at: 1, ms: -5 })
    expect(log.all()[0]).toMatchObject({ ms: 0 })
  })
})

describe('review log: launch cost', () => {
  /** Fastest of three `applyUpdateV2` runs of `update` into a fresh doc, in ms. */
  function applyMs(update: Uint8Array): number {
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      Y.applyUpdateV2(new Y.Doc(), update)
      best = Math.min(best, performance.now() - t0)
    }
    return best
  }

  // Inflating the doc is most of a large library's launch, and review objects were most of that.
  test('100,000 reviews inflate at least 3× faster than the same reviews as legacy objects', () => {
    const compact = device(15)
    for (let card = 0; card < 5_000; card++)
      compact.log.recordMany(
        Array.from({ length: 20 }, (_, j) => ({ cardId: `card-${card}`, rating: 3 as const, at: j, ms: 4_000 })),
      )
    // The very same events, written the way earlier versions did.
    const legacy = new Y.Doc()
    const legacyArray = legacy.getArray<Review>(ROOT.reviews)
    legacyArray.push(reviewEvents(compact.doc))
    expect(legacyArray.length).toBe(100_000)
    expect(new ReviewLog(legacy, seededRng(1), 'x').all()).toEqual(compact.log.all())
    const compactMs = applyMs(Y.encodeStateAsUpdateV2(compact.doc))
    const legacyMs = applyMs(Y.encodeStateAsUpdateV2(legacy))
    expect(compactMs * 3).toBeLessThan(legacyMs)
  }, 60_000)
})
