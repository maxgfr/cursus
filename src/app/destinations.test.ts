import { describe, expect, test } from 'bun:test'
import { blobRef } from '../core/log/blobs'
import { bmanKey, parseKey } from '../core/log/codec'
import { memoryLocks } from '../core/ports/locks'
import { seededRng } from '../core/ports/rng'
import { createSyncEngine } from '../core/sync/engine'
import { device, world } from '../core/sync/harness.test'
import { zipStore } from '../core/sync/providers/zip'
import type { SyncScheduler } from '../core/sync/scheduler'
import { loadCatalog } from '../i18n/index.ts'
import {
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
