import { describe, expect, test } from 'bun:test'
import { codec as v1Codec } from '../../tests/fixtures/v1-reader/codec'
import { blobRef } from '../core/log/blobs'
import { blobKey, bmanKey, parseKey } from '../core/log/codec'
import { addPhoto } from '../core/model/photos'
import { memoryLocks } from '../core/ports/locks'
import { seededRng } from '../core/ports/rng'
import { createSyncEngine } from '../core/sync/engine'
import { device, world } from '../core/sync/harness.test'
import { zipStore } from '../core/sync/providers/zip'
import type { SyncScheduler } from '../core/sync/scheduler'
import { loadCatalog } from '../i18n/index.ts'
import {
  absorb,
  bootDestinations,
  commit,
  createAppEngine,
  DestinationError,
  type DestRecord,
  exportBackup,
  type Host,
  keyringFor,
  saveRecord,
} from './destinations.ts'

async function setup(seed = 1) {
  const w = world(seed)
  const d = await device(seed, w.clock)
  const rng = seededRng(seed + 100, w.clock)
  const host: Host = { store: d.store, log: d.log, clock: w.clock, rng, seal: () => d.commit() }
  const parts = { store: d.store, log: d.log, blobs: d.blobs, locks: memoryLocks(), clock: w.clock, rng, doc: d.doc }
  return { w, d, host, parts, engine: createAppEngine({ ...parts, checkpointEvery: 0 }) }
}

const scheduler = (): SyncScheduler & { triggers: string[] } => {
  const triggers: string[] = []
  return {
    triggers,
    start() {},
    stop() {},
    trigger(r) {
      triggers.push(r)
    },
    whenIdle: async () => {},
    failures: () => 0,
  }
}

describe('sealed destinations', () => {
  test('the app engine seals uploads to a sealed destination once its key is unlocked', async () => {
    const { w, d, host, engine } = await setup()
    const ring = keyringFor(host, 'sealed-1')
    await ring.create('correct horse battery')
    const id = engine.addDest({ remote: w.remote(), id: 'sealed-1', sealed: true, keyring: ring })
    d.ws.courses.create({ title: 'Toxicology' })
    await d.commit()
    const r = await engine.round(id)
    expect(r.up).toBeGreaterThan(0)
    const st = engine.status().dests.find((x) => x.id === id)
    expect(st?.state).toBe('ok')
    // Every data object went up sealed (CRSE), never in the clear.
    const remote = w.remote()
    for await (const e of remote.list('')) {
      const kind = parseKey(e.key)?.kind
      if (kind !== 'seg') continue
      const body = (await remote.get(e)) as Uint8Array
      expect(new TextDecoder().decode(body.slice(0, 4))).toBe('CRSE')
    }
  })

  test('an engine without a sealer cannot sync a sealed destination (the bug this guards)', async () => {
    const { w, d, host, parts } = await setup(2)
    const plain = createSyncEngine({ ...parts, checkpointEvery: 0 })
    const ring = keyringFor(host, 'sealed-2')
    await ring.create('correct horse battery')
    const id = plain.addDest({ remote: w.remote(), id: 'sealed-2', sealed: true, keyring: ring })
    d.ws.courses.create({ title: 'x' })
    await d.commit()
    await plain.round(id)
    expect(plain.status().dests.find((x) => x.id === id)?.state).toBe('needs-passphrase')
  })

  test('a locked key surfaces needs-passphrase', async () => {
    const { w, d, host, engine } = await setup(3)
    const ring = keyringFor(host, 'sealed-3')
    await ring.create('correct horse battery')
    await ring.lock()
    const id = engine.addDest({ remote: w.remote(), id: 'sealed-3', sealed: true, keyring: ring })
    d.ws.courses.create({ title: 'x' })
    await d.commit()
    await engine.round(id)
    expect(engine.status().dests.find((x) => x.id === id)?.state).toBe('needs-passphrase')
  })
})

describe('boot', () => {
  const s3: DestRecord = {
    kind: 's3',
    id: '',
    label: 'bucket · localhost:9000',
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    bucket: 'bucket',
    prefix: 'cursus',
    accessKeyId: 'k',
    secretAccessKey: 's',
  }

  test('every remembered destination rejoins the engine at boot, and a round is asked for', async () => {
    const { host, engine } = await setup(4)
    await saveRecord(host, { ...s3, id: 'dest-a' })
    await saveRecord(host, { ...s3, id: 'dest-b', paused: true })
    const sched = scheduler()
    expect(await bootDestinations(host, engine, sched, null)).toBeNull()
    expect(engine.destIds().sort()).toEqual(['dest-a', 'dest-b'])
    expect(sched.triggers).toContain('manual')
  })

  test('an OAuth return with nothing pending is a no-op; a failed exchange is reported, not thrown', async () => {
    const { host, engine } = await setup(5)
    expect(await bootDestinations(host, engine, scheduler(), 'oauth:none')).toBeNull()
    await host.store.commit([{ put: 'kv', key: 'oauth:st', value: { params: { state: 'st' }, receivedAt: 0 } }])
    const { saveDraft } = await import('./destinations.ts')
    await saveDraft(host, 'st', { kind: 'dropbox', label: 'Dropbox', clientId: 'app', secretName: 'dbx', root: '' })
    const out = await bootDestinations(host, engine, scheduler(), 'oauth:st')
    expect(out !== null && 'error' in out).toBe(true)
  })
})

describe('backup export', () => {
  test('carries every local segment, and counts files this device never received', async () => {
    const { d, host, engine } = await setup(6)
    const course = d.ws.courses.create({ title: 'Histology' })
    // A PDF added on another device: the note refers to it, its bytes have not reached this one.
    const absent = 'ab'.repeat(32)
    d.ws.sources.create({ courseId: course, kind: 'pdf', title: 'iPad scan', blobId: blobRef(absent) })
    const present = await d.attach(new TextEncoder().encode('a file this device holds'))
    await d.commit()
    const backup = await exportBackup(host, engine)
    const keys = new Set<string>()
    for await (const e of zipStore({ bytes: backup.bytes }).list('')) keys.add(e.key)
    for (const k of await d.log.keys()) expect(keys.has(k)).toBe(true)
    expect(keys.has(bmanKey(present))).toBe(true)
    expect(keys.has(bmanKey(absent))).toBe(false)
    expect(backup.missingFiles).toBe(1)
  })

  test('a photo kept on demand counts as missing when its bytes cannot be fetched (offline), fetched when they can', async () => {
    // Device A takes a photo and syncs it; device B (an iPad keeping photos on demand) gets its manifest only.
    const w = world(8)
    const a = await device(81, w.clock)
    const da = a.engine.addDest({ remote: w.remote() })
    const photo = await a.blobs.put(new Uint8Array(300).fill(5), 'image/jpeg')
    const course = a.ws.courses.create({ title: 'Bio' })
    addPhoto(a.ws, { courseId: course, title: 'Board', blobId: photo })
    await a.commit()
    await a.engine.round(da)
    const b = await device(82, w.clock, { onDemand: (mime) => mime.startsWith('image/') })
    const db = b.engine.addDest({ remote: w.remote() })
    await b.engine.round(db)
    expect(await b.blobs.read(bmanKey(photo))).not.toBeNull()
    expect(await b.blobs.get(photo)).toBeNull()
    const host: Host = {
      store: b.store,
      log: b.log,
      clock: w.clock,
      rng: seededRng(83, w.clock),
      seal: () => b.commit(),
    }
    const keysOf = async (bytes: Uint8Array) => {
      const keys = new Set<string>()
      for await (const e of zipStore({ bytes }).list('')) keys.add(e.key)
      return keys
    }
    const chunks = (await b.blobs.manifest(photo))?.chunks.map(blobKey) ?? []
    expect(chunks.length).toBeGreaterThan(0)

    // Offline: no destination can be reached. The archive holds the manifest but not the photo's bytes.
    b.engine.removeDest(db)
    const offline = await exportBackup(host, b.engine)
    const offlineKeys = await keysOf(offline.bytes)
    expect(chunks.some((c) => offlineKeys.has(c))).toBe(false)
    expect(offline.missingFiles).toBe(1)

    // Online: the photo is fetched from the destination first, and the archive is complete.
    b.engine.addDest({ remote: w.remote() })
    const online = await exportBackup(host, b.engine)
    const onlineKeys = await keysOf(online.bytes)
    for (const c of chunks) expect(onlineKeys.has(c)).toBe(true)
    expect(online.missingFiles).toBe(0)
  })

  test('a backup made by this build is kept as needs-upgrade by the previous build, never half applied', async () => {
    const { w, d, host, engine } = await setup(9)
    const course = d.ws.courses.create({ title: 'Anatomy' })
    const card = d.ws.cards.create({ courseId: course, kind: 'basic' })
    d.ws.reviews.record({ cardId: card, rating: 3, at: w.clock.now(), ms: 1_000 })
    await d.commit()
    const backup = await exportBackup(host, engine)
    const prev = await device(91, w.clock, { codec: v1Codec })
    const prevHost: Host = {
      store: prev.store,
      log: prev.log,
      clock: w.clock,
      rng: seededRng(92, w.clock),
      seal: () => prev.commit(),
    }
    await absorb(prevHost, prev.engine, zipStore({ bytes: backup.bytes }))
    expect(prev.engine.status().needsUpgrade).toBeGreaterThan(0)
    expect(prev.ws.cards.list()).toEqual([])
    // This build reads its own backup whole.
    const next = await device(93, w.clock)
    const nextHost: Host = {
      store: next.store,
      log: next.log,
      clock: w.clock,
      rng: seededRng(94, w.clock),
      seal: () => next.commit(),
    }
    await absorb(nextHost, next.engine, zipStore({ bytes: backup.bytes }))
    expect(next.ws.reviews.forCard(card)).toHaveLength(1)
  })

  test('a complete library exports with nothing missing', async () => {
    const { d, host, engine } = await setup(7)
    d.ws.courses.create({ title: 'Anatomy' })
    await d.commit()
    const backup = await exportBackup(host, engine)
    expect(backup.missingFiles).toBe(0)
  })
})

describe('registry errors', () => {
  test('are typed, and every code reads in the sync namespace', async () => {
    const { host, engine } = await setup(8)
    const err = await commit(host, engine, { kind: 'folder', label: 'Gone', id: 'no-handle' }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DestinationError)
    expect((err as DestinationError).code).toBe('errUnavailable')
    for (const locale of ['en', 'de', 'fr'] as const) {
      const { sync } = await loadCatalog(locale)
      for (const code of ['errUnavailable', 'errNoState', 'errNoFolders'] as const) expect(sync[code]).toBeTruthy()
    }
  })
})
