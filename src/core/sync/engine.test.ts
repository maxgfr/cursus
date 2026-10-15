import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { RemoteError } from '../contracts/errors'
import type { Key, RemoteStore } from '../contracts/remote'
import { createKeyring } from '../crypto/keyring'
import { createSealer, isSealed } from '../crypto/sealer'
import { blobKey, bmanKey, codec, encode, parseKey, sha256Hex } from '../log/codec'
import { REPLAY } from '../log/origins'
import { memoryLocks } from '../ports/locks'
import { seededRng } from '../ports/rng'
import { secretsVault } from '../storage/secrets'
import { all, cloneStore, device, FAKE_MAGIC, fakeKeyring, fakeSealer, world } from './harness.test'
import { faultyRemote } from './providers/faulty'
import { memoryRemote } from './providers/memory'
import { ALARM_AFTER_MS } from './status'
import { canonicalJson } from './verify'

const MIN = 60 * 1000

async function keysOf(r: RemoteStore, prefix = ''): Promise<Key[]> {
  return (await all(r.list(prefix))).map((e) => e.key)
}

const sameContent = (a: Y.Doc, b: Y.Doc): void => expect(canonicalJson(a)).toBe(canonicalJson(b))

describe('round: download, apply, upload, confirm', () => {
  test('two devices converge through one destination; markers written; status safe', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const b = await device(2, w.clock)
    const ra = a.engine.addDest({ remote: w.remote(), label: 'Memory' })
    b.engine.addDest({ remote: w.remote() })
    a.ws.courses.create({ title: 'Bio' })
    await a.commit()
    const r1 = await a.engine.round(ra)
    expect(r1.up).toBeGreaterThanOrEqual(3)
    const keys = await keysOf(w.remote())
    expect(keys).toContain('fmt/v1')
    expect(keys.some((k) => k.startsWith('ws/'))).toBe(true)
    expect(keys.filter((k) => k.startsWith('seg/')).length).toBe(1)
    expect(a.engine.status()).toMatchObject({ safe: true, unsealed: 0, protectedOn: 1, alarm: false })
    expect(a.engine.status().dests[0]).toMatchObject({ label: 'Memory', state: 'ok', unconfirmed: 0 })
    const r2 = await b.engine.round(ra)
    expect(r2.down).toBe(1)
    expect(b.ws.courses.list().map((c) => c.title)).toEqual(['Bio'])
    expect(await b.engine.workspaceId()).toBe(await a.engine.workspaceId())
    b.ws.courses.create({ title: 'Chem' })
    await b.commit()
    await b.engine.round(ra)
    await a.engine.round(ra)
    sameContent(a.doc, b.doc)
    expect(a.ws.courses.list().length).toBe(2)
  })

  test('downloaded updates are applied with origin REPLAY and announced to other tabs', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const arrivals: number[] = []
    const origins: unknown[] = []
    const b = await device(2, w.clock, { onIngested: (n) => arrivals.push(n) })
    b.doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    const id = a.engine.addDest({ remote: w.remote() })
    b.engine.addDest({ remote: w.remote() })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    await b.engine.round(id)
    expect(arrivals).toEqual([1])
    expect(origins).toContain(REPLAY)
    expect(await b.store.read(['pending'], (tx) => tx.count('pending'))).toBe(0)
  })

  test('nothing to do: zero moved, nothing re-uploaded', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const id = a.engine.addDest({ remote: w.remote() })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    expect(await a.engine.round(id)).toEqual({ down: 0, up: 0, deferred: 0 })
  })

  test('unknown destination and duplicate add are errors', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const r = w.remote()
    a.engine.addDest({ remote: r })
    expect(() => a.engine.addDest({ remote: r })).toThrow(RangeError)
    expect(() => a.engine.round('nope')).toThrow(RangeError)
    a.engine.removeDest(r.id)
    expect(a.engine.destIds()).toEqual([])
  })

  test('a busy destination lock skips the round instead of queueing it', async () => {
    const w = world()
    const locks = memoryLocks()
    const a = await device(1, w.clock, { locks })
    const id = a.engine.addDest({ remote: w.remote() })
    let release = () => {}
    const held = locks.run(`cursus:sync:${id}`, () => new Promise<void>((r) => (release = r)))
    expect(await a.engine.round(id)).toEqual({ down: 0, up: 0, deferred: 0 })
    release()
    await held
  })

  test('paused destination does nothing; unpausing resumes', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const id = a.engine.addDest({ remote: w.remote(), paused: true })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    expect(await a.engine.round(id)).toEqual({ down: 0, up: 0, deferred: 0 })
    expect(a.engine.status().dests[0]?.state).toBe('paused')
    a.engine.setPaused(id, false)
    expect((await a.engine.round(id)).up).toBeGreaterThan(0)
  })

  test('abort signal stops the round', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const id = a.engine.addDest({ remote: w.remote() })
    const ac = new AbortController()
    ac.abort()
    await expect(a.engine.round(id, ac.signal)).rejects.toThrow()
    expect(a.engine.status().dests[0]?.state).toBe('ok')
  })
})

describe('files: closure', () => {
  test('a segment is never uploaded before its blobs are confirmed on that destination', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const remote = faultyRemote(w.remote())
    const id = a.engine.addDest({ remote })
    const blob = await a.attach(new Uint8Array([1, 2, 3, 4]))
    await a.commit()
    remote.inject('put-lost') // the first PUT after the markers: fmt/v1
    remote.inject('put-lost')
    await a.engine.round(id)
    let keys = await keysOf(w.remote())
    // markers were "lost", chunk and manifest went through, segment too
    expect(keys).toContain(bmanKey(blob))
    // now lose the chunk on a fresh file
    const blob2 = await a.attach(new Uint8Array([9, 9, 9]))
    await a.commit()
    const chunk2 = (await a.blobs.objectKeys(blob2))[0] as Key
    const segsBefore = keys.filter((k) => k.startsWith('seg/')).length
    remote.inject('put-lost')
    const r = await a.engine.round(id)
    keys = await keysOf(w.remote())
    expect(keys).not.toContain(chunk2)
    expect(keys).not.toContain(bmanKey(blob2))
    expect(keys.filter((k) => k.startsWith('seg/')).length).toBe(segsBefore)
    expect(r.deferred).toBeGreaterThan(0)
    expect(a.engine.status().safe).toBe(false)
    // still awaiting: no re-upload before 10 minutes
    expect((await a.engine.round(id)).up).toBe(0)
    w.clock.advance(10 * MIN)
    await a.engine.round(id)
    keys = await keysOf(w.remote())
    expect(keys).toContain(chunk2)
    expect(keys).toContain(bmanKey(blob2))
    expect(keys.filter((k) => k.startsWith('seg/')).length).toBe(segsBefore + 1)
    expect(a.engine.status().safe).toBe(true)
  })

  test('downloading a segment brings its files; a missing file is fetched elsewhere before relaying', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const c = await device(3, w.clock)
    const d1a = a.engine.addDest({ remote: w.remote('d1') })
    const blob = await a.attach(new Uint8Array(100).fill(7))
    await a.commit()
    await a.engine.round(d1a)
    // c got the segment by another path, without the file
    for (const k of await a.log.keys()) await c.log.ingest(k, (await a.log.bytes(k)) as Uint8Array)
    expect(await c.blobs.get(blob)).toBeNull()
    c.engine.addDest({ remote: w.remote('d1') })
    const d2 = c.engine.addDest({ remote: w.remote('d2') })
    await c.engine.round(d2)
    const k2 = await keysOf(w.remote('d2'))
    expect(k2).toContain(bmanKey(blob))
    expect(k2.filter((k) => k.startsWith('seg/')).length).toBe(1)
    expect(await c.blobs.get(blob)).not.toBeNull()
  })

  test('incremental round fetches the files of new segments by key', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const b = await device(2, w.clock)
    const id = a.engine.addDest({ remote: w.remote() })
    b.engine.addDest({ remote: w.remote() })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    await b.engine.round(id) // full (startup)
    const blob = await a.attach(new Uint8Array(50).fill(3))
    await a.commit()
    await a.engine.round(id)
    await b.engine.round(id) // incremental
    expect(await b.blobs.get(blob)).not.toBeNull()
  })

  test('a needs-upgrade segment is relayed only once its files are confirmed; an unreadable one never', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const old = await device(3, w.clock)
    const d1 = a.engine.addDest({ remote: w.remote('d1') })
    const blob = await a.attach(new Uint8Array(40).fill(6))
    await a.commit()
    await a.engine.round(d1)
    // A newer build wrote a segment this (older) device cannot apply: its header still names the file.
    const newer = encode(
      { v: 1, kind: 'seg', deviceId: 'newer', seq: 0, createdAt: 1, blobRefs: [blob] },
      new Uint8Array([255, 255, 255]),
    )
    const v3 = new Uint8Array([0x43, 0x52, 0x53, 0x59, 3, 7, 7])
    const opaque = `seg/future/0000000000-${sha256Hex(v3).slice(0, 16)}.seg`
    expect(await old.log.ingest(newer.key, newer.bytes)).toMatchObject({ state: 'needs-upgrade' })
    expect(await old.log.ingest(opaque, v3)).toMatchObject({ state: 'needs-upgrade' })
    const d2 = old.engine.addDest({ remote: w.remote('d2') })
    const r = await old.engine.round(d2)
    const k2 = await keysOf(w.remote('d2'))
    expect(k2).not.toContain(newer.key)
    expect(k2).not.toContain(opaque)
    expect(r.deferred).toBeGreaterThanOrEqual(2)
    expect(old.engine.status()).toMatchObject({ safe: false, needsUpgrade: 2 })
    // Once the file is reachable (d1), the readable segment goes with it; the unreadable one stays local.
    old.engine.addDest({ remote: w.remote('d1') })
    await old.engine.round(d2)
    const after = await keysOf(w.remote('d2'))
    expect(after).toContain(newer.key)
    expect(after).toContain(bmanKey(blob))
    expect(after).not.toContain(opaque)
  })

  test('a file nobody has leaves the segment deferred, not uploaded', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const c = await device(3, w.clock)
    await a.attach(new Uint8Array([5]))
    await a.commit()
    for (const k of await a.log.keys()) await c.log.ingest(k, (await a.log.bytes(k)) as Uint8Array)
    const id = c.engine.addDest({ remote: w.remote() })
    const r = await c.engine.round(id)
    expect(r.deferred).toBe(1)
    expect((await keysOf(w.remote())).filter((k) => k.startsWith('seg/'))).toEqual([])
  })
})

describe('listing', () => {
  test('incremental rounds list from watermarks and only new devices; full every 30 min', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const b = await device(2, w.clock)
    const rb = w.remote('d1')
    const id = a.engine.addDest({ remote: w.remote('d1') })
    b.engine.addDest({ remote: rb })
    for (let i = 0; i < 3; i++) {
      a.ws.courses.create({ title: `c${i}` })
      await a.commit()
    }
    await a.engine.round(id)
    await b.engine.round(id)
    const listsAfterFull = rb.calls.list
    a.ws.courses.create({ title: 'more' })
    await a.commit()
    await a.engine.round(id)
    const r = await b.engine.round(id)
    expect(r.down).toBe(1)
    // keys/, ws/, ckpt/, seg/<a>/ from watermark, seg/ after the newest device; nothing under blob/
    expect(rb.calls.list - listsAfterFull).toBeGreaterThanOrEqual(5)
    expect(b.ws.courses.list().length).toBe(4)
    // a device whose id sorts BEFORE the known ones is found in the gap listing
    const seg = encode(
      { v: 1, kind: 'seg', deviceId: '00000000000000000000000000', seq: 0, createdAt: 1, blobRefs: [] },
      (() => {
        const d = new Y.Doc()
        d.clientID = 77
        d.getMap('courses').set('zz', new Y.Map())
        return Y.encodeStateAsUpdateV2(d)
      })(),
    )
    await w.remote('d1').put(seg.key, seg.bytes)
    expect((await b.engine.round(id)).down).toBe(1)
    // a file nothing references is not listed incrementally; the full listing every 30 min finds it
    const orphan = new Uint8Array([4, 2])
    await w.remote('d1').put(blobKey(sha256Hex(orphan)), orphan)
    expect((await b.engine.round(id)).down).toBe(0)
    w.clock.advance(30 * MIN)
    expect((await b.engine.round(id)).down).toBe(1)
  })

  test('mangled names are ignored: they are never downloaded', async () => {
    const w = world()
    const b = await device(2, w.clock)
    const id = b.engine.addDest({ remote: w.remote() })
    await w.remote().put('seg/dev/0000000000-0123456789abcdef 2.seg', new Uint8Array([1]))
    await w.remote().put('mirror/Bio/notes.md', new Uint8Array([1]))
    expect((await b.engine.round(id)).down).toBe(0)
  })

  test('created-after and none modes', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const b = await device(2, w.clock)
    const ida = a.engine.addDest({ remote: w.remote(), incremental: 'none' })
    b.engine.addDest({ remote: w.remote(), incremental: 'created-after' })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(ida)
    await a.engine.round(ida)
    await b.engine.round(ida)
    a.ws.courses.create({ title: 'y' })
    await a.commit()
    await a.engine.round(ida)
    w.clock.advance(1000)
    expect((await b.engine.round(ida)).down).toBe(1)
  })

  test('a round lists the way its store declares: created-after in three calls, none in one, whatever the devices', async () => {
    const w = world()
    // Three devices write to the destination, so a start-after round would list each of them.
    for (const seed of [1, 2, 3]) {
      const d = await device(seed, w.clock)
      const id = d.engine.addDest({ remote: w.remote() })
      await d.engine.round(id) // joins the workspace first
      d.ws.courses.create({ title: `c${seed}` })
      await d.commit()
      await d.engine.round(id)
    }
    const listsPerRound = async (incremental: RemoteStore['incremental']): Promise<number[]> => {
      const b = await device(9, w.clock)
      const r = w.remote()
      const id = b.engine.addDest({ remote: { ...r, incremental } })
      const out: number[] = []
      for (let i = 0; i < 3; i++) {
        const before = r.calls.list
        await b.engine.round(id)
        out.push(r.calls.list - before)
        w.clock.advance(1000)
      }
      expect(b.ws.courses.list().length).toBe(3)
      return out
    }
    // The first round lists everything once, then checks by listing what it has just uploaded.
    expect(await listsPerRound('created-after')).toEqual([2, 3, 3])
    expect(await listsPerRound('none')).toEqual([2, 1, 1])
    // keys/, ws/, ckpt/, one per device from its watermark, and the gaps around the three devices.
    expect(await listsPerRound(undefined)).toEqual([2, 10, 10])
  })

  test('a relaunch lists from where it left off: only the saved time of the last full listing decides', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const r = w.remote()
    const id = a.engine.addDest({ remote: { ...r, incremental: 'created-after' } })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    w.clock.advance(MIN)
    // The same device, launched again (or another tab): a new engine on the same store.
    const again = await device(1, w.clock, { store: a.store })
    again.engine.addDest({ id, remote: { ...r, incremental: 'created-after' } })
    const before = r.calls.list
    await again.engine.round(id)
    expect(r.calls.list - before).toBe(3)
    w.clock.advance(30 * MIN)
    const late = r.calls.list
    await again.engine.round(id)
    expect(r.calls.list - late).toBe(1)
  })

  test('a key a full listing leaves out, but that is there when checked again, stays confirmed', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const r = w.remote()
    let hidden: Key | null = null
    // A listing of the whole destination that lags behind (eventual consistency): one segment is missing from it.
    const lagging: RemoteStore = {
      ...r,
      list: (prefix, lo) => {
        const inner = r.list(prefix, lo)
        return {
          async *[Symbol.asyncIterator]() {
            for await (const e of inner) if (prefix !== '' || e.key !== hidden) yield e
          },
        }
      },
    }
    const id = a.engine.addDest({ remote: lagging })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    hidden = (await keysOf(r, 'seg/'))[0] as Key
    w.clock.advance(31 * MIN)
    const puts = r.calls.put
    await a.engine.round(id)
    expect(r.calls.put).toBe(puts)
    expect(a.engine.status()).toMatchObject({ safe: true, protectedOn: 1 })
    expect(a.engine.status().dests[0]?.unconfirmed).toBe(0)
  })

  test('a key confirmed earlier but missing from a full listing is sent again', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const id = a.engine.addDest({ remote: w.remote() })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    const seg = (await keysOf(w.remote(), 'seg/'))[0] as Key
    w.bucket.remove(`d1/${seg}`)
    w.clock.advance(31 * MIN)
    const r = await a.engine.round(id)
    expect(r.up).toBe(1)
    expect(await keysOf(w.remote(), 'seg/')).toEqual([seg])
  })
})

describe('integrity', () => {
  test('a corrupt copy is skipped for an intact duplicate', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const b = await device(2, w.clock)
    const id = a.engine.addDest({ remote: w.remote() })
    b.engine.addDest({ remote: w.remote() })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    const seg = (await keysOf(w.remote(), 'seg/'))[0] as Key
    const good = w.bucket.read(`d1/${seg}`) as Uint8Array
    w.bucket.corrupt(`d1/${seg}`)
    w.bucket.duplicate(`d1/${seg}`, good)
    expect((await b.engine.round(id)).down).toBe(1)
    expect(b.ws.courses.list().length).toBe(1)
  })

  test('a hash mismatch is transient, then reported after N failures', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const b = await device(2, w.clock, { maxHashFailures: 2 })
    const id = a.engine.addDest({ remote: w.remote() })
    b.engine.addDest({ remote: w.remote() })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    const seg = (await keysOf(w.remote(), 'seg/'))[0] as Key
    w.bucket.corrupt(`d1/${seg}`)
    expect((await b.engine.round(id)).deferred).toBe(1)
    expect(b.engine.status().dests[0]?.corrupt).toBe(0)
    await b.engine.round(id)
    expect(b.engine.status().dests[0]).toMatchObject({ corrupt: 1, reason: 'corrupt' })
    // the author repairs it (verify), the reader recovers
    await a.engine.verify(id)
    await b.engine.round(id)
    expect(b.engine.status().dests[0]?.corrupt).toBe(0)
    expect(b.engine.status().dests[0]?.reason).toBeUndefined()
    expect(b.ws.courses.list().length).toBe(1)
  })

  test('a key reported corrupt on one destination stops counting once it came from another', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const b = await device(2, w.clock, { maxHashFailures: 1 })
    const d1 = a.engine.addDest({ remote: w.remote('d1') })
    const d2 = a.engine.addDest({ remote: w.remote('d2') })
    b.engine.addDest({ remote: w.remote('d1') })
    b.engine.addDest({ remote: w.remote('d2') })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(d1)
    await a.engine.round(d2)
    const seg = (await keysOf(w.remote('d1'), 'seg/'))[0] as Key
    w.bucket.corrupt(`d1/${seg}`)
    await b.engine.round(d1)
    expect(b.engine.status().dests[0]?.corrupt).toBe(1)
    await b.engine.round(d2)
    await b.engine.round(d1)
    expect(b.engine.status().dests[0]?.corrupt).toBe(0)
  })

  test('a corrupt read (transient) is retried next round', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const b = await device(2, w.clock)
    const rb = faultyRemote(w.remote())
    const id = a.engine.addDest({ remote: w.remote() })
    b.engine.addDest({ remote: rb })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    rb.inject('get-corrupt')
    expect((await b.engine.round(id)).down).toBe(0)
    expect((await b.engine.round(id)).down).toBe(1)
  })
})

describe('errors become states, never silence', () => {
  test.each([
    ['auth', 'needs-auth'],
    ['rate-limit', 'backoff'],
    ['quota', 'error'],
    ['put-before', 'backoff'],
  ] as const)('%s ⇒ %s, error thrown and recorded', async (fault, state) => {
    const w = world()
    const a = await device(1, w.clock)
    const remote = faultyRemote(w.remote())
    const id = a.engine.addDest({ remote })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    if (fault === 'auth') remote.authExpired = true
    else if (fault === 'quota') remote.quotaFull = true
    else remote.inject(fault, 1)
    await expect(a.engine.round(id)).rejects.toBeInstanceOf(RemoteError)
    expect(a.engine.status().dests[0]?.state).toBe(state)
    expect(a.engine.status().dests[0]?.error?.kind).toBeDefined()
    expect(a.engine.status().safe).toBe(false)
    remote.heal()
    await a.engine.round(id)
    expect(a.engine.status().dests[0]?.state).toBe('ok')
    expect(a.engine.status().dests[0]?.error).toBeUndefined()
    expect(a.engine.status().safe).toBe(true)
  })

  test('stored-then-failed upload: confirmed by the next listing, not uploaded twice', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const remote = faultyRemote(w.remote())
    const id = a.engine.addDest({ remote })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    remote.inject('put-after')
    await expect(a.engine.round(id)).rejects.toThrow()
    const r = await a.engine.round(id)
    expect(r.up).toBeGreaterThan(0)
    expect(a.engine.status().safe).toBe(true)
  })

  test('non-remote errors put the destination in error and propagate', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const broken: RemoteStore = {
      id: 'broken',
      list: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new TypeError('bug')),
        }),
      }),
      get: async () => null,
      put: async () => {},
    }
    const id = a.engine.addDest({ remote: broken })
    await expect(a.engine.round(id)).rejects.toThrow(TypeError)
    expect(a.engine.status().dests[0]?.state).toBe('error')
  })
})

describe('status tells the truth', () => {
  test('no destination ⇒ never safe; red banner after 24 h confirmed nowhere', async () => {
    const w = world()
    const a = await device(1, w.clock)
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    expect((await a.engine.refresh()).safe).toBe(false)
    expect(a.engine.status().alarm).toBe(false)
    w.clock.advance(ALARM_AFTER_MS + 1)
    expect((await a.engine.refresh()).alarm).toBe(true)
    const id = a.engine.addDest({ remote: w.remote() })
    await a.engine.round(id)
    expect(a.engine.status()).toMatchObject({ alarm: false, safe: true })
  })

  test('unsealed edits keep status unsafe; subscribers are notified', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const id = a.engine.addDest({ remote: w.remote() })
    const seen: boolean[] = []
    const off = a.engine.subscribe((s) => seen.push(s.safe))
    a.ws.courses.create({ title: 'x' })
    await Promise.resolve()
    await a.engine.round(id)
    expect(a.engine.status().unsealed).toBeGreaterThan(0)
    expect(a.engine.status().safe).toBe(false)
    await a.commit()
    await a.engine.round(id)
    expect(a.engine.status().safe).toBe(true)
    off()
    expect(seen.length).toBeGreaterThan(0)
    a.engine.noteSchedule(id, w.clock.now() + 5000)
    expect(a.engine.status().dests[0]).toMatchObject({ state: 'backoff', nextTryAt: w.clock.now() + 5000 })
    a.engine.noteSchedule(id, undefined)
    a.engine.noteSchedule('unknown', undefined)
    expect(a.engine.status().dests[0]?.nextTryAt).toBeUndefined()
  })

  test('updates not yet acknowledged by the local log keep the status unsafe', async () => {
    const w = world()
    let unsaved = 2
    const a = await device(1, w.clock, { unsaved: () => unsaved })
    const id = a.engine.addDest({ remote: w.remote() })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    expect(a.engine.status()).toMatchObject({ safe: false, unsaved: 2 })
    expect(a.engine.status().unsealed).toBeGreaterThanOrEqual(2)
    unsaved = 0
    expect(await a.engine.refresh()).toMatchObject({ safe: true, unsaved: 0, unsealed: 0 })
  })

  test('protected on N counts only fully confirmed destinations', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const d1 = a.engine.addDest({ remote: w.remote('d1') })
    a.engine.addDest({ remote: w.remote('d2') })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(d1)
    expect(a.engine.status()).toMatchObject({ safe: true, protectedOn: 1 })
    expect(a.engine.status().dests[1]?.unconfirmed).toBeGreaterThan(0)
    expect(a.engine.status().dests[1]?.oldestUnconfirmedAt).toBeDefined()
  })
})

describe('workspace guard', () => {
  async function foreignDest(w: ReturnType<typeof world>) {
    const other = await device(9, w.clock)
    const id = other.engine.addDest({ remote: w.remote() })
    other.ws.courses.create({ title: 'theirs' })
    await other.commit()
    await other.engine.round(id)
    return id
  }

  test('an empty library adopts the remote workspace silently', async () => {
    const w = world()
    const id = await foreignDest(w)
    const b = await device(2, w.clock)
    b.engine.addDest({ remote: w.remote() })
    await b.engine.round(id)
    expect(b.ws.courses.list().map((c) => c.title)).toEqual(['theirs'])
  })

  test('a non-empty library asks; refusal pauses without merging or uploading', async () => {
    const w = world()
    const id = await foreignDest(w)
    const asked: unknown[] = []
    const b = await device(2, w.clock, {
      confirmWorkspace: async (q) => {
        asked.push(q)
        return false
      },
    })
    b.ws.courses.create({ title: 'mine' })
    await b.commit()
    b.engine.addDest({ remote: w.remote() })
    const before = await keysOf(w.remote())
    expect(await b.engine.round(id)).toEqual({ down: 0, up: 0, deferred: 0 })
    expect(asked.length).toBe(1)
    expect(b.engine.status().dests[0]).toMatchObject({ state: 'paused', reason: 'workspace' })
    expect(await keysOf(w.remote())).toEqual(before)
    expect(b.ws.courses.list().map((c) => c.title)).toEqual(['mine'])
  })

  test('without a confirmation callback a foreign workspace is refused', async () => {
    const w = world()
    const id = await foreignDest(w)
    const b = await device(2, w.clock)
    b.ws.courses.create({ title: 'mine' })
    await b.commit()
    b.engine.addDest({ remote: w.remote() })
    await b.engine.round(id)
    expect(b.engine.status().dests[0]?.reason).toBe('workspace')
  })

  test('confirmation merges and remembers the alias', async () => {
    const w = world()
    const id = await foreignDest(w)
    let asked = 0
    const b = await device(2, w.clock, {
      confirmWorkspace: async () => {
        asked++
        return true
      },
    })
    b.ws.courses.create({ title: 'mine' })
    await b.commit()
    b.engine.addDest({ remote: w.remote() })
    await b.engine.round(id)
    await b.engine.round(id)
    expect(asked).toBe(1)
    expect(new Set(b.ws.courses.list().map((c) => c.title))).toEqual(new Set(['mine', 'theirs']))
    expect((await keysOf(w.remote(), 'ws/')).length).toBe(2)
  })
})

describe('clone', () => {
  test('a cloned profile: both replicas take a new deviceId, nothing is lost', async () => {
    const w = world()
    const clones: [string, string][] = []
    const a = await device(1, w.clock, { clones })
    const id = a.engine.addDest({ remote: w.remote() })
    a.ws.courses.create({ title: 'before' })
    await a.commit()
    await a.engine.round(id)
    const twin = await device(2, w.clock, { store: await cloneStore(a.store), clones })
    twin.engine.addDest({ remote: w.remote() })
    const me = await a.log.deviceId()
    expect(await twin.log.deviceId()).toBe(me)
    a.ws.courses.create({ title: 'a' })
    await a.commit()
    twin.ws.courses.create({ title: 'twin' })
    await twin.commit()
    await a.engine.round(id)
    await twin.engine.round(id)
    await a.engine.round(id)
    expect(clones.length).toBe(2)
    expect(await a.log.deviceId()).not.toBe(me)
    expect(await twin.log.deviceId()).not.toBe(me)
    expect(await a.log.deviceId()).not.toBe(await twin.log.deviceId())
    sameContent(a.doc, twin.doc)
    expect(a.ws.courses.list().length).toBe(3)
  })
})

describe('sealed destinations (engine side)', () => {
  test('keys/* seen ⇒ needs-passphrase without an unlocked key; nothing is sent', async () => {
    const w = world()
    await w.remote().put(`keys/${'0'.repeat(64)}.json`, new Uint8Array([1]))
    const a = await device(1, w.clock, { sealer: fakeSealer })
    const ring = await fakeKeyring('a', false)
    const id = a.engine.addDest({ remote: w.remote(), keyring: ring })
    a.ws.courses.create({ title: 'secret' })
    await a.commit()
    await a.engine.round(id)
    expect(a.engine.status().dests[0]?.state).toBe('needs-passphrase')
    expect(await keysOf(w.remote())).toEqual([`keys/${'0'.repeat(64)}.json`])
    ring.unlock()
    await a.engine.round(id)
    expect(a.engine.status().dests[0]?.state).toBe('ok')
    for (const k of await keysOf(w.remote(), 'seg/')) {
      expect([...(w.bucket.read(`d1/${k}`) as Uint8Array).slice(0, 4)]).toEqual(FAKE_MAGIC)
    }
  })

  test('no sealer or keyring configured for a sealed destination ⇒ needs-passphrase', async () => {
    const w = world()
    await w.remote().put(`keys/${'1'.repeat(64)}.json`, new Uint8Array([1]))
    const a = await device(1, w.clock)
    const id = a.engine.addDest({ remote: w.remote() })
    await a.engine.round(id)
    expect(a.engine.status().dests[0]?.state).toBe('needs-passphrase')
  })

  test('the sealed hint encrypts even before keys/ is listed; relay sealed ⇄ plain', async () => {
    const w = world()
    const ring = await fakeKeyring()
    const a = await device(1, w.clock, { sealer: fakeSealer })
    const c = await device(3, w.clock, { sealer: fakeSealer })
    const sealedA = a.engine.addDest({ remote: w.remote('sealed'), keyring: ring, sealed: true })
    const blob = await a.attach(new Uint8Array([1, 2, 3]))
    await a.commit()
    await a.engine.round(sealedA)
    for (const k of await keysOf(w.remote('sealed'))) {
      const kind = parseKey(k)?.kind
      if (kind === 'fmt' || kind === 'ws' || kind === 'keys') continue // key envelopes are readable JSON
      expect([...(w.bucket.read(`sealed/${k}`) as Uint8Array).slice(0, 4)]).toEqual(FAKE_MAGIC)
    }
    c.engine.addDest({ remote: w.remote('sealed'), keyring: await fakeKeyring(), sealed: true })
    const plain = c.engine.addDest({ remote: w.remote('plain') })
    await c.engine.round(sealedA)
    await c.engine.round(plain)
    expect(c.ws.sources.list().length).toBe(1)
    expect(w.bucket.read(`plain/${bmanKey(blob)}`)).toEqual(await a.blobs.read(bmanKey(blob)))
  })

  test('an object sealed with a key not unlocked here ⇒ needs-passphrase, upload withheld', async () => {
    const w = world()
    const a = await device(1, w.clock, { sealer: fakeSealer })
    const id = a.engine.addDest({ remote: w.remote(), keyring: await fakeKeyring('a'), sealed: true })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    const b = await device(2, w.clock, { sealer: fakeSealer, confirmWorkspace: async () => true })
    b.engine.addDest({ remote: w.remote(), keyring: await fakeKeyring('b'), sealed: true })
    b.ws.courses.create({ title: 'y' })
    await b.commit()
    const r = await b.engine.round(id)
    expect(r.up).toBe(0)
    expect(b.engine.status().dests[0]?.state).toBe('needs-passphrase')
  })

  test('key files are handed to the keyring when nothing is unlocked yet', async () => {
    const w = world()
    const body = new TextEncoder().encode('{"v":1}')
    await w.remote().put(`keys/${sha256Hex(body)}.json`, body)
    const ring = await fakeKeyring('a', false)
    const a = await device(1, w.clock, { sealer: fakeSealer })
    const id = a.engine.addDest({ remote: w.remote(), keyring: ring })
    await a.engine.round(id)
    expect((ring as unknown as { learned: string[] }).learned).toEqual([`keys/${sha256Hex(body)}.json`])
  })
})

/** A remote whose listings lose every `keys/` entry — on the full listing only, or everywhere. */
function losingKeys(inner: RemoteStore, everywhere: { on: boolean }): RemoteStore {
  return {
    id: inner.id,
    get: (e) => inner.get(e),
    put: (k, b) => inner.put(k, b),
    list(prefix, o) {
      return {
        async *[Symbol.asyncIterator]() {
          for await (const e of inner.list(prefix, o)) {
            if (e.key.startsWith('keys/') && (prefix === '' || everywhere.on)) continue
            yield e
          }
        },
      }
    },
  }
}

const dataKeys = async (r: RemoteStore): Promise<Key[]> =>
  (await keysOf(r)).filter((k) => ['seg', 'ckpt', 'blob', 'bman'].includes(parseKey(k)?.kind ?? ''))

describe('sealedness is established before anything is sent', () => {
  async function sealedWith(w: ReturnType<typeof world>) {
    const a = await device(1, w.clock, { sealer: fakeSealer })
    const id = a.engine.addDest({ remote: w.remote(), keyring: await fakeKeyring(), sealed: true })
    await a.attach(new Uint8Array([1, 2, 3]))
    await a.commit()
    await a.engine.round(id)
    return { id, a }
  }

  test('a sealed bucket added without the hint: a first listing that lost keys/ still never sends plaintext', async () => {
    const w = world()
    const { id } = await sealedWith(w)
    const b = await device(2, w.clock, { sealer: fakeSealer, confirmWorkspace: async () => true })
    b.ws.courses.create({ title: 'mine' })
    await b.commit()
    b.engine.addDest({ remote: losingKeys(w.remote(), { on: false }), keyring: await fakeKeyring(), id })
    await b.engine.round(id)
    const after = await dataKeys(w.remote())
    expect(after.filter((k) => k.startsWith('seg/')).length).toBe(2)
    for (const k of after) expect(isSealed(w.bucket.read(`d1/${k}`) as Uint8Array)).toBe(true)
    // Seen sealed once, sealed forever: the next full listing loses keys/ again, nothing changes.
    b.ws.courses.create({ title: 'more' })
    await b.commit()
    w.clock.advance(31 * MIN)
    await b.engine.round(id)
    const later = await dataKeys(w.remote())
    expect(later.filter((k) => k.startsWith('seg/')).length).toBe(3)
    for (const k of later) expect(isSealed(w.bucket.read(`d1/${k}`) as Uint8Array)).toBe(true)
  })

  test('sealedness that cannot be established ⇒ nothing is sent that round', async () => {
    const w = world()
    const { id, a } = await sealedWith(w)
    const c = await device(3, w.clock, { sealer: fakeSealer, confirmWorkspace: async () => true })
    c.ws.courses.create({ title: 'mine' })
    await c.commit()
    // c already holds a's segment (received through another destination).
    for (const k of await a.log.keys()) await c.log.ingest(k, (await a.log.bytes(k)) as Uint8Array)
    c.engine.addDest({ remote: losingKeys(w.remote(), { on: true }), keyring: await fakeKeyring(), id })
    const before = await keysOf(w.remote())
    expect((await c.engine.round(id)).up).toBe(0)
    expect(await keysOf(w.remote())).toEqual(before)
    expect(c.engine.status().dests[0]).toMatchObject({ reason: 'seal-unknown' })
    expect(c.engine.status().safe).toBe(false)
    // Verify must not "repair" objects it cannot judge: they stay as they are, sealed.
    await c.engine.verify(id)
    expect(await keysOf(w.remote())).toEqual(before)
    for (const k of await dataKeys(w.remote())) expect(isSealed(w.bucket.read(`d1/${k}`) as Uint8Array)).toBe(true)
  })

  test('a plaintext destination is proven by what it holds; an empty one is initialised in the clear', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const b = await device(2, w.clock, { confirmWorkspace: async () => true })
    const id = a.engine.addDest({ remote: w.remote() })
    b.engine.addDest({ remote: w.remote() })
    await a.engine.round(id) // empty library: markers only
    b.ws.courses.create({ title: 'x' })
    await b.commit()
    await b.engine.round(id)
    expect((await dataKeys(w.remote())).length).toBe(1)
    expect(b.engine.status().safe).toBe(true)
  })
})

test('a damaged plaintext marker is put back, so devices that were not told can still prove plaintext', async () => {
  const w = world()
  const remote = faultyRemote(w.remote())
  const a = await device(1, w.clock)
  const b = await device(2, w.clock, { confirmWorkspace: async () => true })
  const id = a.engine.addDest({ remote })
  b.engine.addDest({ remote: w.remote() })
  remote.inject('put-corrupt', 2) // both markers of an empty library are stored damaged
  await a.engine.round(id)
  b.ws.courses.create({ title: 'x' })
  await b.commit()
  expect((await b.engine.round(id)).up).toBe(0)
  expect(b.engine.status().dests[0]?.reason).toBe('seal-unknown')
  await a.engine.round(id) // markers confirmed: read back damaged, put again
  await a.engine.round(id)
  await b.engine.round(id)
  expect((await dataKeys(w.remote())).length).toBe(1)
  expect(b.engine.status().dests[0]?.reason).toBeUndefined()
})

describe('key envelopes are a synced set', () => {
  async function sealedDevice(w: ReturnType<typeof world>) {
    const a = await device(1, w.clock, { sealer: createSealer(seededRng(5)) })
    const ring = createKeyring({ secrets: secretsVault(a.store), destId: 'd1', rng: seededRng(6), iterations: 1000 })
    const file = await ring.create('correct horse')
    const puts: Key[] = []
    const inner = faultyRemote(w.remote())
    const remote: RemoteStore = {
      id: inner.id,
      list: (p, o) => inner.list(p, o),
      get: (e) => inner.get(e),
      put: async (k, b) => {
        puts.push(k)
        await inner.put(k, b)
      },
    }
    const id = a.engine.addDest({ remote, keyring: ring, sealed: true })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    return { a, ring, file, id, puts, inner }
  }

  test('the local envelope is uploaded and confirmed before any sealed object', async () => {
    const w = world()
    const { a, file, id, puts } = await sealedDevice(w)
    await a.engine.round(id)
    expect(await keysOf(w.remote(), 'keys/')).toEqual([file.key])
    const firstData = puts.findIndex((k) => parseKey(k)?.kind === 'seg')
    expect(puts.indexOf(file.key)).toBeGreaterThanOrEqual(0)
    expect(puts.indexOf(file.key)).toBeLessThan(firstData)
    expect(a.engine.status().safe).toBe(true)
  })

  test('a lost key file is put back, and the destination is not safe until it is confirmed', async () => {
    const w = world()
    const { a, file, id, inner } = await sealedDevice(w)
    await a.engine.round(id)
    w.bucket.remove(`d1/${file.key}`)
    w.clock.advance(31 * MIN)
    inner.inject('put-lost', 1)
    await a.engine.round(id)
    expect(await keysOf(w.remote(), 'keys/')).toEqual([])
    expect(a.engine.status().safe).toBe(false)
    await a.engine.round(id)
    expect(await keysOf(w.remote(), 'keys/')).toEqual([file.key])
    expect(a.engine.status().safe).toBe(true)
  })

  test('verify reads every envelope back: a damaged one is put again', async () => {
    const w = world()
    const { a, file, id } = await sealedDevice(w)
    await a.engine.round(id)
    w.bucket.corrupt(`d1/${file.key}`)
    await a.engine.verify(id)
    expect(w.bucket.read(`d1/${file.key}`)).toEqual(file.body)
    expect(a.engine.status().safe).toBe(true)
  })

  test('a new passphrase envelope kept only locally is uploaded', async () => {
    const w = world()
    const { a, ring, id } = await sealedDevice(w)
    await a.engine.round(id)
    const next = await ring.changePassphrase('correct horse', 'battery staple')
    await a.engine.round(id)
    expect(await keysOf(w.remote(), 'keys/')).toContain(next.key)
  })

  test('the restore drill opens the destination with its own key files only', async () => {
    const w = world()
    const { a, file, id } = await sealedDevice(w)
    await a.engine.round(id)
    expect(await a.engine.restoreDrill(id)).toEqual({ equal: true, diff: [] })
    w.bucket.remove(`d1/${file.key}`)
    const r = await a.engine.restoreDrill(id)
    expect(r.equal).toBe(false)
    expect(r.diff).toEqual(['destination: needs-passphrase'])
  })
})

describe('checkpoints', () => {
  test('built from persisted data, uploaded, and downloaded first by a new device', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const id = a.engine.addDest({ remote: w.remote() })
    for (let i = 0; i < 3; i++) {
      a.ws.courses.create({ title: `c${i}` })
      await a.commit()
    }
    const key = await a.engine.checkpoint()
    expect(key).toMatch(/^ckpt\//)
    expect(await a.engine.checkpoint()).toBeNull()
    await a.engine.round(id)
    expect((await keysOf(w.remote(), 'ckpt/')).length).toBe(1)
    const order: string[] = []
    const fresh = await device(5, w.clock)
    fresh.engine.addDest({ remote: w.remote() })
    await fresh.engine.round(id)
    for (const s of await fresh.log.since(0)) order.push(s.rec.header.kind)
    expect(order[0]).toBe('ckpt')
    sameContent(fresh.doc, a.doc)
  })

  test('the checkpoint is considered once per change of the log, not once per destination', async () => {
    const w = world()
    let decoded = 0
    const counting = {
      ...codec,
      decode: (k: Key, b: Uint8Array) => {
        decoded++
        return codec.decode(k, b)
      },
    }
    const a = await device(1, w.clock, { checkpointEvery: 2, codec: counting })
    const d1 = a.engine.addDest({ remote: w.remote('d1') })
    const d2 = a.engine.addDest({ remote: w.remote('d2') })
    a.ws.courses.create({ title: 'a' })
    await a.commit()
    a.ws.courses.create({ title: 'b' })
    await a.commit()
    await a.engine.round(d1)
    expect((await keysOf(w.remote('d1'), 'ckpt/')).length).toBe(1)
    // The second destination finds the log unchanged: nothing is read or decoded again for a checkpoint.
    decoded = 0
    await a.engine.round(d2)
    await a.engine.round(d1)
    expect(decoded).toBe(0)
    expect((await keysOf(w.remote('d2'), 'ckpt/')).length).toBe(1)
  })

  test('automatic checkpoints when enough segments are uncovered', async () => {
    const w = world()
    const a = await device(1, w.clock, { checkpointEvery: 2 })
    const id = a.engine.addDest({ remote: w.remote() })
    a.ws.courses.create({ title: 'a' })
    await a.commit()
    await a.engine.round(id)
    expect((await keysOf(w.remote(), 'ckpt/')).length).toBe(0)
    a.ws.courses.create({ title: 'b' })
    await a.commit()
    await a.engine.round(id)
    expect((await keysOf(w.remote(), 'ckpt/')).length).toBe(1)
  })
})

describe('verify', () => {
  test('repairs a corrupt or vanished object from local bytes; reports what it could not', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const id = a.engine.addDest({ remote: w.remote() })
    await a.attach(new Uint8Array([1, 2, 3]))
    await a.commit()
    await a.engine.round(id)
    const seg = (await keysOf(w.remote(), 'seg/'))[0] as Key
    w.bucket.corrupt(`d1/${seg}`)
    const progress: [number, number][] = []
    const r = await a.engine.verify(id, (d, t) => progress.push([d, t]))
    expect(r).toEqual({ missing: 0, corrupt: 1, repaired: 1 })
    expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1])
    expect(a.engine.status().dests[0]?.lastVerifiedAt).toBe(w.clock.now())
    expect(await a.engine.verify(id)).toEqual({ missing: 0, corrupt: 0, repaired: 0 })
    // an object that only the destination had, now corrupt, cannot be repaired here
    const b = await device(2, w.clock, { confirmWorkspace: async () => true })
    b.ws.courses.create({ title: 'b' })
    await b.commit()
    const idB = b.engine.addDest({ remote: w.remote() })
    await b.engine.round(idB)
    const bSeg = (await keysOf(w.remote(), 'seg/')).find((k) => !k.includes(seg.split('/')[1] as string)) as Key
    w.bucket.corrupt(`d1/${bSeg}`)
    const c = await device(3, w.clock)
    c.engine.addDest({ remote: w.remote() })
    const rc = await c.engine.verify(idB)
    expect(rc.corrupt).toBe(1)
    expect(rc.repaired).toBe(0)
  })

  test('re-uploads missing objects; resumes where it stopped', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const remote = faultyRemote(w.remote())
    const id = a.engine.addDest({ remote })
    for (let i = 0; i < 4; i++) {
      a.ws.courses.create({ title: `c${i}` })
      await a.commit()
    }
    await a.engine.round(id)
    const seg = (await keysOf(w.remote(), 'seg/'))[0] as Key
    w.bucket.remove(`d1/${seg}`)
    // interrupt after two objects have been checked
    let armed = false
    let gets = 0
    const counting: RemoteStore = {
      id: remote.id,
      list: (p, o) => remote.list(p, o),
      put: (k, b) => remote.put(k, b),
      get: async (e) => {
        if (armed && ++gets === 3) throw new RemoteError('network', 'cut')
        return remote.get(e)
      },
    }
    const b = await device(2, w.clock)
    const idB = b.engine.addDest({ remote: counting, id })
    await b.engine.round(idB)
    armed = true
    await expect(b.engine.verify(idB)).rejects.toThrow('cut')
    const before = gets
    const r = await b.engine.verify(idB)
    expect(gets - before).toBe(1)
    expect(r.corrupt).toBe(0)
    const ra = await a.engine.verify(id)
    expect(ra).toMatchObject({ missing: 1, repaired: 1 })
    expect(await keysOf(w.remote(), 'seg/')).toContain(seg)
  })

  test('sealed object with an unknown key cannot be judged: needs-passphrase', async () => {
    const w = world()
    const a = await device(1, w.clock, { sealer: fakeSealer })
    const id = a.engine.addDest({ remote: w.remote(), keyring: await fakeKeyring('a'), sealed: true })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    const b = await device(2, w.clock, { sealer: fakeSealer })
    const ring = await fakeKeyring('b')
    b.engine.addDest({ remote: w.remote(), keyring: ring, sealed: true })
    await b.engine.verify(id)
    expect(b.engine.status().dests[0]?.state).toBe('needs-passphrase')
  })
})

describe('restoreDrill', () => {
  test('rebuilds from one destination and compares canonical state', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const d1 = a.engine.addDest({ remote: w.remote('d1') })
    const d2 = a.engine.addDest({ remote: w.remote('d2') })
    const blob = await a.attach(new Uint8Array([4, 4]))
    a.ws.courses.create({ title: 'Bio' })
    await a.commit()
    await a.engine.round(d1)
    expect(await a.engine.restoreDrill(d1)).toEqual({ equal: true, diff: [] })
    const r2 = await a.engine.restoreDrill(d2)
    expect(r2.equal).toBe(false)
    expect(r2.diff.length).toBeGreaterThan(0)
    // a destination missing a file is caught too
    await a.engine.round(d2)
    w.bucket.remove(`d2/${bmanKey(blob)}`)
    for (const k of await a.blobs.objectKeys(blob)) w.bucket.remove(`d2/${k}`)
    const r3 = await a.engine.restoreDrill(d2)
    expect(r3.diff).toContain(`blob ${blob}: missing`)
    expect(blobKey('ab'.repeat(32))).toMatch(/^blob\/ab\//)
  })

  test('a sealed destination without the key reports its state', async () => {
    const w = world()
    await w.remote().put(`keys/${'2'.repeat(64)}.json`, new Uint8Array([1]))
    const a = await device(1, w.clock, { sealer: fakeSealer })
    const id = a.engine.addDest({ remote: w.remote(), keyring: await fakeKeyring('a', false) })
    expect(await a.engine.restoreDrill(id)).toEqual({ equal: false, diff: ['destination: needs-passphrase'] })
  })

  test('memoryRemote ids differ by prefix', () => {
    const w = world()
    expect(memoryRemote({ bucket: w.bucket, prefix: 'a' }).id).not.toBe(
      memoryRemote({ bucket: w.bucket, prefix: 'b' }).id,
    )
  })
})

describe('error discipline', () => {
  test('a failure while opening that is not an integrity problem propagates (round and verify)', async () => {
    const w = world()
    const ring = await fakeKeyring()
    const a = await device(1, w.clock, { sealer: fakeSealer })
    const id = a.engine.addDest({ remote: w.remote(), keyring: ring, sealed: true })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    const broken = {
      seal: fakeSealer.seal,
      open: async () => {
        throw new TypeError('store gone')
      },
    }
    const b = await device(2, w.clock, { sealer: broken })
    b.engine.addDest({ remote: w.remote(), keyring: ring, sealed: true })
    await expect(b.engine.round(id)).rejects.toThrow(TypeError)
    expect(b.engine.status().dests[0]?.state).toBe('error')
    const c = await device(3, w.clock, { sealer: fakeSealer })
    c.engine.addDest({ remote: w.remote(), keyring: ring, sealed: true })
    await c.engine.round(id)
    const c2 = await device(4, w.clock, { sealer: broken, store: c.store })
    c2.engine.addDest({ remote: w.remote(), keyring: ring, sealed: true })
    await expect(c2.engine.verify(id)).rejects.toThrow(TypeError)
  })

  test('verify re-sends a lost upload without waiting for the 10-minute window', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const remote = faultyRemote(w.remote())
    const id = a.engine.addDest({ remote })
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    remote.inject('put-lost', 3)
    await a.engine.round(id)
    expect(a.engine.status().safe).toBe(false)
    const r = await a.engine.verify(id)
    expect(r.missing).toBeGreaterThan(0)
    expect(a.engine.status().safe).toBe(true)
  })
})
