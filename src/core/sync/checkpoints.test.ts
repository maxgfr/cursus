import { expect, test } from 'bun:test'
import * as Y from 'yjs'
import { codec, encode, keyFor, MAGIC } from '../log/codec'
import { buildCheckpoint, coveredBy, persistedDoc } from './checkpoints'
import { device, world } from './harness.test'
import { canonicalJson } from './verify'

test('checkpoint: fresh doc from persisted segments, stops before needs-upgrade, covers exactly those', async () => {
  const w = world()
  const a = await device(1, w.clock)
  a.ws.courses.create({ title: 'one' })
  await a.commit()
  const v3 = new Uint8Array([...MAGIC, 3, 0])
  const future = keyFor({ v: 1, kind: 'seg', deviceId: 'future', seq: 0, createdAt: 0, blobRefs: [] }, v3)
  await a.log.ingest(future, v3)
  const d = new Y.Doc()
  d.getMap('prefs').set('theme', 'dark')
  const after = encode(
    { v: 1, kind: 'seg', deviceId: 'zz', seq: 0, createdAt: 0, blobRefs: [] },
    Y.encodeStateAsUpdateV2(d),
  )
  await a.log.ingest(after.key, after.bytes)
  const deviceId = await a.log.deviceId()
  expect(await buildCheckpoint({ store: a.store, log: a.log, clock: w.clock, deviceId, every: 2 })).toBeNull()
  const rec = await buildCheckpoint({ store: a.store, log: a.log, clock: w.clock, deviceId, every: 1 })
  expect(rec?.header.kind).toBe('ckpt')
  expect(rec?.header.covers?.length).toBe(1)
  expect(rec?.header.covers).not.toContain(future)
  expect(rec?.header.covers).not.toContain(after.key)
  expect(await buildCheckpoint({ store: a.store, log: a.log, clock: w.clock, deviceId, every: 1 })).toBeNull()
  // persisted state excludes pending edits
  a.ws.courses.create({ title: 'pending only' })
  const persisted = await persistedDoc(a.store)
  expect(persisted.getMap('courses').size).toBe(1)
  expect(persisted.getMap('prefs').get('theme')).toBe('dark')
  expect(canonicalJson(persisted)).not.toBe(canonicalJson(a.doc))
  await a.log.compact()
  expect((await persistedDoc(a.store)).getMap('courses').size).toBe(1)
  expect(coveredBy([])).toEqual(new Set())
})

test('checkpoint: uncovered segments are counted from their headers; nothing is decoded until one is due', async () => {
  const w = world()
  const a = await device(1, w.clock)
  for (const title of ['one', 'two', 'three']) {
    a.ws.courses.create({ title })
    await a.commit()
  }
  let decoded = 0
  const counting = {
    ...codec,
    decode: (k: string, b: Uint8Array) => {
      decoded++
      return codec.decode(k, b)
    },
  }
  const deviceId = await a.log.deviceId()
  const o = { store: a.store, log: a.log, clock: w.clock, deviceId, codec: counting }
  expect(await buildCheckpoint({ ...o, every: 4 })).toBeNull()
  expect(decoded).toBe(0)
  expect((await buildCheckpoint({ ...o, every: 3 }))?.header.covers?.length).toBe(3)
  expect(decoded).toBe(3)
})
