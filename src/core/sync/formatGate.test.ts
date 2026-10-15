import { describe, expect, test } from 'bun:test'
import { codec as v1Codec } from '../../../tests/fixtures/v1-reader/codec'
import { MAGIC } from '../log/codec'
import { buildCheckpoint } from './checkpoints'
import { device, world } from './harness.test'

/**
 * A device still on the previous build (the last one reading only envelope version 1: its frozen codec drives
 * that device's local log and engine) syncing with this build, whose reviews live in roots it does not know.
 */
describe('format gate between this build and the previous one', () => {
  async function pair() {
    const w = world(11)
    const next = await device(1, w.clock)
    const prev = await device(2, w.clock, { codec: v1Codec })
    const dn = next.engine.addDest({ remote: w.remote() })
    const dp = prev.engine.addDest({ remote: w.remote() })
    // A course and a card written by the previous build: version 1, read by both.
    const course = prev.ws.courses.create({ title: 'Bio' })
    const card = prev.ws.cards.create({ courseId: course, kind: 'basic' })
    await prev.commit()
    await prev.engine.round(dp)
    await next.engine.round(dn)
    return { w, next, prev, dn, dp, card }
  }

  test('reviews written by this build are kept as needs-upgrade there, never applied without them', async () => {
    const { w, next, prev, dn, dp, card } = await pair()
    expect(next.ws.cards.get(card)).toBeDefined()
    next.ws.reviews.record({ cardId: card, rating: 3, at: w.clock.now(), ms: 2_000 })
    await next.commit()
    await next.engine.round(dn)
    // Every segment this build wrote is version 2; the previous build's are version 1, kept as they came.
    const mine = `seg/${await next.log.deviceId()}/`
    const theirs = `seg/${await prev.log.deviceId()}/`
    const versions = new Map<string, number[]>()
    for (const key of await next.log.keys()) {
      const who = key.startsWith(mine) ? 'next' : key.startsWith(theirs) ? 'prev' : 'other'
      versions.set(who, [...(versions.get(who) ?? []), (await next.log.bytes(key))?.[MAGIC.length] ?? 0])
    }
    expect(Object.fromEntries(versions)).toEqual({ next: [2], prev: [1] })
    await prev.engine.round(dp)
    // Said (the needs-upgrade notice counts it), and nothing of it applied: no partial state.
    expect(prev.engine.status().needsUpgrade).toBeGreaterThan(0)
    expect(prev.doc.getArray('reviewLog').length).toBe(0)
    expect(prev.ws.reviews.forCard(card)).toEqual([])
    // Once the app is updated (this build over the same device store), its first launch applies the kept
    // segment by itself: nothing is left to retry.
    const updated = await device(3, w.clock, { store: prev.store })
    expect(updated.ws.reviews.forCard(card)).toHaveLength(1)
    expect(await updated.log.retryUpgrades()).toBe(0)
  })

  test('a checkpoint of this build is needs-upgrade for the previous one; its own segments stay readable here', async () => {
    const { w, next, prev, card } = await pair()
    next.ws.reviews.record({ cardId: card, rating: 4, at: w.clock.now(), ms: 1_000 })
    await next.commit()
    const ckpt = await buildCheckpoint({
      store: next.store,
      log: next.log,
      clock: w.clock,
      deviceId: await next.log.deviceId(),
      every: 1,
    })
    if (!ckpt) throw new Error('no checkpoint')
    const bytes = await next.log.bytes(ckpt.key)
    if (!bytes) throw new Error('checkpoint not stored')
    expect(bytes[MAGIC.length]).toBe(2)
    expect(await prev.log.ingest(ckpt.key, bytes)).toMatchObject({ state: 'needs-upgrade' })
    // The previous build's own version-1 segments were applied here as usual.
    expect(next.ws.cards.get(card)).toMatchObject({ kind: 'basic' })
  })
})
