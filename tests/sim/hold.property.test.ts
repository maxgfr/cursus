import { expect, test } from 'bun:test'
import fc from 'fast-check'
import * as Y from 'yjs'
import { encode } from '../../src/core/log/codec'
import { device, type TestDevice, world } from '../../src/core/sync/harness.test'
import { HOLD_AT_COUNT, HOLD_AT_SHARE, HOLD_SHARE_MIN_LIBRARY, HOLD_WINDOW_MS } from '../../src/core/sync/holdGuard'
import { canonicalJson } from '../../src/core/sync/verify'

const RUNS = Number(process.env.FC_RUNS ?? 100)
const HOUR = 60 * 60 * 1000

interface Step {
  /** Cards trashed, in one segment. */
  trash: number
  /** Trashed by a forged segment under a device id never seen before, instead of by device A. */
  forged: boolean
  /** Whether B syncs right after. */
  syncB: boolean
  /** Time passing after the step. */
  wait: number
}

const planArb = fc.record({
  cards: fc.integer({ min: 4, max: 45 }),
  steps: fc.array(
    fc.record({
      trash: fc.integer({ min: 1, max: 12 }),
      forged: fc.boolean(),
      syncB: fc.boolean(),
      wait: fc.oneof(
        fc.constant(0),
        fc.integer({ min: 1, max: 30 }).map((h) => h * HOUR),
      ),
    }),
    { minLength: 1, maxLength: 8 },
  ),
  keep: fc.boolean(),
})

const live = (d: TestDevice): number => d.ws.courses.list().length + d.ws.cards.list().length

/** A segment trashing `ids`, as if from another device `deviceId`, written straight to the destination. */
function forge(base: Y.Doc, deviceId: string, clientID: number, ids: readonly string[]) {
  const doc = new Y.Doc()
  doc.clientID = clientID
  Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(base))
  const sv = Y.encodeStateVector(doc)
  doc.transact(() => {
    for (const id of ids) doc.getMap<Y.Map<unknown>>('cards').get(id)?.set('deletedAt', 1)
  })
  return encode({ v: 1, kind: 'seg', deviceId, seq: 0, createdAt: 1, blobRefs: [] }, Y.encodeStateAsUpdateV2(doc, sv))
}

async function decide(d: TestDevice, mode: 'apply' | 'keep'): Promise<void> {
  const held = await d.engine.held()
  d.ws.absorbHeld(
    held.map((h) => h.update),
    mode,
  )
  await d.engine.release(held.map((h) => h.key))
  await d.commit()
}

/**
 * "A remote mass deletion never reaches the live doc without consent": whatever way device A, or any number of
 * forged device ids, spread deletions over segments, rounds and time, what B loses within any window stays under
 * the thresholds; once both devices decide, they converge (on the deletions, or on the library brought back).
 */
test('sync guard: a remote mass deletion never reaches the live doc without consent', async () => {
  const out = await fc.check(
    fc.asyncProperty(planArb, async ({ cards, steps, keep }) => {
      const w = world()
      const a = await device(1, w.clock, { holdDeletions: true })
      const b = await device(2, w.clock, { holdDeletions: true })
      const id = a.engine.addDest({ remote: w.remote() })
      b.engine.addDest({ remote: w.remote() })
      const courseId = a.ws.courses.create({ title: 'Library' })
      const ids = Array.from({ length: cards }, () => a.ws.cards.create({ courseId, kind: 'basic' }))
      await a.commit()
      await a.engine.round(id)
      await b.engine.round(id)
      const all = live(b)
      /** Entities B lost, per round time. */
      const losses: { at: number; lost: number }[] = []
      const syncB = async () => {
        const before = live(b)
        await b.engine.round(id)
        const now = w.clock.now()
        losses.push({ at: now, lost: before - live(b) })
        const recent = losses.filter((l) => l.at > now - HOLD_WINDOW_MS).reduce((n, l) => n + l.lost, 0)
        const library = live(b) + recent
        expect(recent).toBeLessThan(HOLD_AT_COUNT)
        if (library >= HOLD_SHARE_MIN_LIBRARY) expect(recent).toBeLessThan(library * HOLD_AT_SHARE)
      }
      let next = 0
      let forgers = 0
      for (const s of steps as Step[]) {
        const batch = ids.slice(next, next + s.trash)
        next += batch.length
        if (batch.length > 0 && s.forged) {
          forgers++
          const { key, bytes } = forge(a.doc, `forged${forgers}`, 5000 + forgers, batch)
          await w.remote().put(key, bytes)
        } else if (batch.length > 0) {
          a.ws.batch(() => {
            for (const c of batch) a.ws.cards.trash(c)
          })
          await a.commit()
          await a.engine.round(id)
        }
        if (s.syncB) await syncB()
        w.clock.advance(s.wait)
      }
      await syncB()
      const shown = live(b)
      expect(shown).toBeLessThanOrEqual(all)
      await decide(b, keep ? 'keep' : 'apply')
      // Keeping changes nothing visible here.
      if (keep) expect(live(b)).toBe(shown)
      // A judged the forged segments too: it decides the same way.
      await a.engine.round(id)
      await decide(a, keep ? 'keep' : 'apply')
      await b.engine.round(id)
      await a.engine.round(id)
      await b.engine.round(id)
      expect(canonicalJson(a.doc)).toBe(canonicalJson(b.doc))
      expect(await b.engine.held()).toEqual([])
      expect(await a.engine.held()).toEqual([])
    }),
    { numRuns: RUNS },
  )
  if (out.failed) {
    console.error(`FAILING SEED: { seed: ${out.seed}, path: '${out.counterexamplePath}' }`)
    console.error(fc.defaultReportMessage(out), out.errorInstance)
  }
  expect(out.failed).toBe(false)
}, 120_000)
