import { expect, test } from 'bun:test'
import * as Y from 'yjs'
import { codec as v1Codec } from '../../tests/fixtures/v1-reader/codec'
import type { EnvelopeCodec } from '../core/contracts/log'
import type { Clock } from '../core/contracts/ports'
import { createLocalLog } from '../core/log/localLog'
import { createWorkspace } from '../core/model/workspace'
import { defaultLocks } from '../core/ports/locks'
import { cryptoRng } from '../core/ports/rng'
import { createScheduler, DAY_MS, type ReplaySnapshot } from '../core/srs/fsrs'
import { REPLAYS_KEY, readSavedReplays } from '../core/srs/savedReplays'
import { type IdbStore, idbStore } from '../core/storage/idbStore'
import { computeStudy } from '../ui/data/useStudy.ts'
import { loadReplica } from './workspaceContext.tsx'

const T = Date.UTC(2026, 0, 5, 9, 0, 0)
// A retention no other test uses: its scheduler (shared per parameter set) has replayed nothing yet.
const RETENTION = 0.83
// A due time only the saved replays know: a full replay never lands on it.
const MARK = T + 4_321

test('the first study computation starts from the saved replays even when they are read after the library', async () => {
  const name = `replica-${crypto.randomUUID()}`
  const clock: Clock = { now: () => T }
  const rng = cryptoRng(clock)
  const locks = defaultLocks()

  // An earlier launch: one reviewed card, persisted, and the replays it saved.
  const before = idbStore({ name })
  const doc = new Y.Doc()
  const ws = createWorkspace(doc, { rng, clock, deviceId: 'dev-a' })
  ws.prefs.set('desiredRetention', RETENTION)
  const course = ws.courses.create({ title: 'Law' })
  const card = ws.cards.create({ courseId: course, kind: 'basic' })
  for (const days of [9, 6, 2]) ws.reviews.record({ cardId: card, rating: 3, at: T - days * DAY_MS, ms: 2000 })
  await createLocalLog({ store: before, locks, clock, rng }).appendLocal(Y.encodeStateAsUpdateV2(doc))
  const earlier = createScheduler({ desiredRetention: RETENTION, maximumInterval: 36_501 })
  earlier.replay(card, ws.reviews.forCard(card))
  const taken = earlier.snapshot()
  const nums = Float64Array.from(taken.nums)
  nums[3] = MARK
  const saved: ReplaySnapshot = {
    ...taken,
    params: createScheduler({ desiredRetention: RETENTION }).snapshot().params,
    nums,
  }
  await before.commit([{ put: 'kv', key: REPLAYS_KEY, value: saved }])
  before.close()

  // This launch: the saved replays come in only once the library has been read.
  const store = idbStore({ name })
  let libraryRead = false
  let replaysIn = false
  const watched: IdbStore = {
    ...store,
    read: (stores, fn) =>
      store.read(stores, fn).then((r) => {
        if (stores.includes('segments')) libraryRead = true
        return r
      }),
  }
  const replica = await loadReplica({
    store: watched,
    locks,
    clock,
    rng,
    readReplays: async (s) => {
      const snap = await readSavedReplays(s)
      while (!libraryRead) await new Promise((r) => setTimeout(r, 1))
      await new Promise((r) => setTimeout(r, 20))
      replaysIn = true
      return snap
    },
  })
  expect(replaysIn).toBe(true)
  expect(replica.replays?.nums[3]).toBe(MARK)

  const scheduler = createScheduler({ desiredRetention: RETENTION })
  const replayed = scheduler.replays
  const study = computeStudy(replica.ws, T, replica.replays)
  expect(study.courses[0]?.nextDue).toBe(MARK)
  expect(scheduler.replays).toBe(replayed)
  store.close()
})

test('changes an earlier build kept as needs-upgrade are applied on the first launch of a build that reads them', async () => {
  const clock: Clock = { now: () => T }
  const rng = cryptoRng(clock)
  const locks = defaultLocks()

  // Another device, on this build, writes a card (a version-2 segment).
  const other = idbStore({ name: `other-${crypto.randomUUID()}` })
  const otherDoc = new Y.Doc()
  const otherWs = createWorkspace(otherDoc, { rng, clock, deviceId: 'dev-b' })
  const course = otherWs.courses.create({ title: 'Anatomy' })
  const card = otherWs.cards.create({ courseId: course, kind: 'basic' })
  const otherLog = createLocalLog({ store: other, locks, clock, rng })
  await otherLog.appendLocal(Y.encodeStateAsUpdateV2(otherDoc))
  const seg = await otherLog.seal()
  if (!seg) throw new Error('nothing sealed')
  const bytes = await otherLog.bytes(seg.key)
  if (!bytes) throw new Error('segment not stored')
  other.close()

  // This device, still on the previous build (reads version 1 only), receives it and keeps it aside.
  const name = `upgraded-${crypto.randomUUID()}`
  const before = idbStore({ name })
  const previous = createLocalLog({ store: before, locks, clock, rng, codec: v1Codec })
  expect(await previous.ingest(seg.key, bytes)).toMatchObject({ state: 'needs-upgrade' })
  expect((await loadReplicaWith(before, v1Codec)).cards.get(card)).toBeUndefined()
  before.close()

  // Updated: the first launch of this build applies it, and it stays applied.
  const store = idbStore({ name })
  const replica = await loadReplica({ store, locks, clock, rng })
  expect(replica.ws.cards.get(card)).toMatchObject({ courseId: course, kind: 'basic' })
  expect(await replica.log.retryUpgrades()).toBe(0)
  const rows = await store.read(['segments'], (tx) => tx.getAll<{ state: string }>('segments'))
  expect(rows.map((r) => r.state)).toEqual(['applied'])
  store.close()

  async function loadReplicaWith(s: IdbStore, codec: EnvelopeCodec) {
    const { updates } = await createLocalLog({ store: s, locks, clock, rng, codec }).load()
    const doc = new Y.Doc()
    for (const u of updates) Y.applyUpdateV2(doc, u)
    return createWorkspace(doc, { rng, clock, deviceId: 'dev-a' })
  }
})
