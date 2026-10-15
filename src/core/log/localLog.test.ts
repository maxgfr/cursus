import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import type { EnvelopeCodec } from '../contracts/log'
import type { LocalStore, Locks } from '../contracts/ports'
import { virtualClock } from '../ports/clock'
import { memoryLocks } from '../ports/locks'
import { seededRng } from '../ports/rng'
import { memoryStore } from '../storage/memoryStore'
import { codec, encode, keyFor, MAGIC } from './codec'
import { createLocalLog, type LocalLogOptions, type SegmentRow } from './localLog'
import { CaptureStoppedError, captureUpdates, REMOTE, REPLAY, shouldCapture, TAB } from './origins'

function setup(o: Partial<LocalLogOptions> = {}) {
  const store = o.store ?? memoryStore()
  const locks = o.locks ?? memoryLocks()
  const log = createLocalLog({ store, locks, clock: virtualClock(5000), rng: seededRng(1), ...o })
  return { store, locks, log }
}

/** A doc whose local updates are captured into the log, like the app does. */
function editor(log: { appendLocal(u: Uint8Array): Promise<void> }, clientID = 11) {
  const doc = new Y.Doc()
  doc.clientID = clientID
  const writes: Promise<void>[] = []
  doc.on('updateV2', (u: Uint8Array, origin: unknown) => {
    if (shouldCapture(origin)) writes.push(log.appendLocal(u))
  })
  return { doc, flush: () => Promise.all(writes) }
}

function rebuild(updates: Uint8Array[]): Y.Doc {
  const d = new Y.Doc()
  for (const u of updates) Y.applyUpdateV2(d, u, REPLAY)
  return d
}

/** Store wrapper that runs hooks around read/commit, to inject races and crashes. */
function hooked(
  inner: LocalStore,
  h: { beforeCommit?: (ops: Parameters<LocalStore['commit']>[0]) => Promise<void>; onRead?: () => void },
): LocalStore {
  return {
    read: (stores, fn) => {
      h.onRead?.()
      return inner.read(stores, fn)
    },
    commit: async (ops) => {
      await h.beforeCommit?.(ops)
      return inner.commit(ops)
    },
  }
}

const isSealCommit = (ops: Parameters<LocalStore['commit']>[0]) => ops.some((op) => 'deleteRange' in op)

function foreignSegment(deviceId: string, seq: number, fn: (d: Y.Doc) => void, clientID = 99) {
  const d = new Y.Doc()
  d.clientID = clientID
  fn(d)
  return encode({ v: 1, kind: 'seg', deviceId, seq, createdAt: 1, blobRefs: [] }, Y.encodeStateAsUpdateV2(d))
}

describe('seal', () => {
  test('nothing pending ⇒ null', async () => {
    const { log } = setup()
    expect(await log.seal()).toBeNull()
  })

  test('merges pending into one own segment, increments seq, empties pending', async () => {
    const { log, store } = setup()
    const { doc, flush } = editor(log)
    doc.getMap('m').set('a', 1)
    doc.getMap('m').set('b', 2)
    await flush()
    const rec = await log.seal()
    const dev = await log.deviceId()
    expect(rec).toMatchObject({
      own: true,
      state: 'applied',
      arrival: 1,
      header: { kind: 'seg', deviceId: dev, seq: 0, createdAt: 5000 },
    })
    expect(await store.read(['pending'], (tx) => tx.count('pending'))).toBe(0)
    expect(await log.keys()).toEqual(new Set([rec?.key ?? '']))
    const bytes = await log.bytes(rec?.key ?? '')
    expect(bytes).not.toBeNull()
    expect(codec.decode(rec?.key ?? '', bytes ?? new Uint8Array()).header.seq).toBe(0)
    expect(await log.bytes('seg/x/0000000000-0123456789abcdef.seg')).toBeNull()
    doc.getMap('m').set('c', 3)
    await flush()
    expect((await log.seal())?.header.seq).toBe(1)
  })

  test('an appendLocal landing during phase (b) survives', async () => {
    const base = memoryStore()
    let log = createLocalLog({ store: base, locks: memoryLocks(), clock: virtualClock(), rng: seededRng(2) })
    let late: Uint8Array | null = null
    const store = hooked(base, {
      beforeCommit: async (ops) => {
        if (!isSealCommit(ops) || late) return
        const d = new Y.Doc()
        d.clientID = 50
        d.getMap('m').set('late', true)
        late = Y.encodeStateAsUpdateV2(d)
        await log.appendLocal(late)
      },
    })
    log = createLocalLog({ store, locks: memoryLocks(), clock: virtualClock(), rng: seededRng(2) })
    const { doc, flush } = editor(log)
    doc.getMap('m').set('early', true)
    await flush()
    await log.seal()
    expect(await base.read(['pending'], (tx) => tx.count('pending'))).toBe(1)
    expect(
      rebuild((await log.load()).updates)
        .getMap('m')
        .toJSON(),
    ).toEqual({ early: true, late: true })
  })
})

describe('crash at each phase loses nothing', () => {
  async function crashAndRecover(make: (base: LocalStore) => Partial<LocalLogOptions>) {
    const base = memoryStore()
    const crashing = createLocalLog({
      store: base,
      locks: memoryLocks(),
      clock: virtualClock(),
      rng: seededRng(3),
      ...make(base),
    })
    const { doc, flush } = editor(crashing)
    doc.getMap('m').set('x', 'kept')
    doc.getText('t').insert(0, 'hello')
    await flush()
    await expect(crashing.seal()).rejects.toThrow('crash')
    const fresh = createLocalLog({ store: base, locks: memoryLocks(), clock: virtualClock(), rng: seededRng(3) })
    expect((await fresh.keys()).size).toBe(0)
    expect(
      rebuild((await fresh.load()).updates)
        .getMap('m')
        .get('x'),
    ).toBe('kept')
    const rec = await fresh.seal()
    expect(rec?.header.seq).toBe(0)
    const after = rebuild((await fresh.load()).updates)
    expect(after.getText('t').toString()).toBe('hello')
    expect(after.getMap('m').get('x')).toBe('kept')
  }

  test('(a) read phase', async () => {
    await crashAndRecover((base) => {
      let n = 0
      return {
        store: hooked(base, {
          onRead: () => {
            if (++n === 2) throw new Error('crash')
          },
        }),
      }
    })
  })
  test('(b) merge/encode phase', async () => {
    const broken: EnvelopeCodec = {
      ...codec,
      encode: () => {
        throw new Error('crash')
      },
    }
    await crashAndRecover(() => ({ codec: broken }))
  })
  test('(c) commit phase', async () => {
    await crashAndRecover((base) => ({
      store: hooked(base, {
        beforeCommit: async (ops) => {
          if (isSealCommit(ops)) throw new Error('crash')
        },
      }),
    }))
  })
})

describe('load', () => {
  test('a seal from another tab between load reads loses no edits', async () => {
    const base = memoryStore()
    const locks = memoryLocks()
    const a = setup({ store: base, locks }).log
    const { doc, flush } = editor(a)
    doc.getMap('m').set('k', 'v')
    await flush()
    let sealed = false
    const racy: LocalStore = {
      read: async (stores, fn) => {
        const out = await base.read(stores, fn)
        if (!sealed && stores.includes('segments')) {
          sealed = true
          await a.seal()
        }
        return out
      },
      commit: (ops) => base.commit(ops),
    }
    const b = setup({ store: racy, locks }).log
    const d = rebuild((await b.load()).updates)
    expect(sealed).toBe(true)
    expect(d.getMap('m').toJSON()).toEqual({ k: 'v' })
  })

  test('snapshot + segments beyond through + pending ≡ live doc', async () => {
    const { log } = setup()
    const { doc, flush } = editor(log)
    const live = () => ({ m: doc.getMap('m').toJSON(), t: doc.getText('t').toString() })
    const check = async () => {
      await flush()
      const d = rebuild((await log.load()).updates)
      expect({ m: d.getMap('m').toJSON(), t: d.getText('t').toString() }).toEqual(live())
    }
    await check()
    doc.getMap('m').set('a', 1)
    await check()
    await log.seal()
    await check()
    doc.getText('t').insert(0, 'abc')
    await flush()
    await log.seal()
    await log.compact()
    await check()
    doc.getText('t').delete(0, 1)
    doc.getMap('m').delete('a')
    await flush()
    await log.seal()
    await check()
    doc.getMap('m').set('z', 'pending only')
    await check()
    const { through } = await log.load()
    expect(through).toBe(3)
  })
})

describe('ingest', () => {
  test('stores a foreign segment without applying it; duplicate detected', async () => {
    const { log } = setup()
    const seg = foreignSegment('other', 0, (d) => d.getMap('m').set('remote', 1))
    const rec = await log.ingest(seg.key, seg.bytes)
    expect(rec).toMatchObject({ own: false, state: 'applied', arrival: 1, header: { deviceId: 'other' } })
    expect(await log.ingest(seg.key, seg.bytes)).toBe('duplicate')
    expect(await log.bytes(seg.key)).toEqual(seg.bytes)
    const since = await log.since(0)
    expect(since.map((s) => s.rec.key)).toEqual([seg.key])
    expect(
      rebuild(since.map((s) => s.update))
        .getMap('m')
        .get('remote'),
    ).toBe(1)
    expect(await log.since(1)).toEqual([])
  })

  test('hash mismatch is thrown (transient for the sync round), nothing stored', async () => {
    const { log } = setup()
    const seg = foreignSegment('other', 0, (d) => d.getMap('m').set('r', 1))
    const bad = seg.bytes.slice()
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff
    await expect(log.ingest(seg.key, bad)).rejects.toThrow(expect.objectContaining({ kind: 'hash' }))
    expect((await log.keys()).size).toBe(0)
  })

  test('non-log keys are refused', async () => {
    const { log } = setup()
    await expect(log.ingest('fmt/v1', new Uint8Array())).rejects.toThrow(RangeError)
    await expect(log.ingest('garbage', new Uint8Array())).rejects.toThrow(RangeError)
  })

  test('checkpoints are ingested too', async () => {
    const { log } = setup()
    const d = new Y.Doc()
    d.getMap('m').set('ck', 1)
    const ck = encode(
      { v: 1, kind: 'ckpt', deviceId: 'other', seq: 0, createdAt: 1, blobRefs: [], covers: [] },
      Y.encodeStateAsUpdateV2(d),
    )
    expect(await log.ingest(ck.key, ck.bytes)).toMatchObject({ header: { kind: 'ckpt' }, state: 'applied' })
  })
})

describe('needs-upgrade', () => {
  test('too-new or undecodable segment is kept, skipped, blocks compaction coverage, then re-applied', async () => {
    const base = memoryStore()
    const locks = memoryLocks()
    const v3 = new Uint8Array([...MAGIC, 3, 1, 2, 3])
    const newerKey = keyFor({ v: 1, kind: 'seg', deviceId: 'future', seq: 0, createdAt: 0, blobRefs: [] }, v3)
    const { log } = setup({ store: base, locks })
    const before = foreignSegment('a', 0, (d) => d.getMap('m').set('before', 1), 1)
    const notYjs = encode(
      { v: 1, kind: 'seg', deviceId: 'b', seq: 0, createdAt: 0, blobRefs: [] },
      new Uint8Array([255, 255, 255]),
    )
    await log.ingest(before.key, before.bytes)
    const rec = await log.ingest(newerKey, v3)
    expect(rec).toMatchObject({ state: 'needs-upgrade', header: { deviceId: 'future', seq: 0 } })
    expect(await log.ingest(notYjs.key, notYjs.bytes)).toMatchObject({ state: 'needs-upgrade' })
    // a segment the current build CAN read, but an older build could not:
    const after = foreignSegment('c', 0, (d) => d.getMap('m').set('after', 1), 3)
    const old: EnvelopeCodec = {
      ...codec,
      decode: (k, b) => {
        if (k === after.key) throw new Error('unreadable by this older build')
        return codec.decode(k, b)
      },
    }
    const oldLog = createLocalLog({ store: base, locks, clock: virtualClock(), rng: seededRng(9), codec: old })
    await expect(oldLog.ingest(after.key, after.bytes)).resolves.toMatchObject({ state: 'needs-upgrade' })
    expect((await log.since(0)).map((s) => s.rec.key)).toEqual([before.key])
    await log.compact()
    const snap = await base.read(['snapshot'], (tx) => tx.get<{ through: number }>('snapshot', 'main'))
    expect(snap?.through).toBe(1)
    expect(await log.retryUpgrades()).toBe(1)
    expect(
      rebuild((await log.load()).updates)
        .getMap('m')
        .toJSON(),
    ).toEqual({ before: 1, after: 1 })
    expect(await log.retryUpgrades()).toBe(0)
  })

  test('a needs-upgrade row keeps the blob refs of a readable header; an unreadable header is flagged', async () => {
    const { log, store } = setup()
    const ref = 'ab'.repeat(32)
    const newer = encode(
      { v: 1, kind: 'seg', deviceId: 'newer', seq: 0, createdAt: 0, blobRefs: [ref] },
      new Uint8Array([255, 255, 255]),
    )
    const rec = await log.ingest(newer.key, newer.bytes)
    expect(rec).toMatchObject({ state: 'needs-upgrade', header: { blobRefs: [ref] } })
    const v3 = new Uint8Array([...MAGIC, 3, 9, 9])
    const opaqueKey = keyFor({ v: 1, kind: 'seg', deviceId: 'future', seq: 0, createdAt: 0, blobRefs: [] }, v3)
    await log.ingest(opaqueKey, v3)
    const rows = await store.read(['segments'], (tx) =>
      Promise.all([newer.key, opaqueKey].map((k) => tx.get<SegmentRow>('segments', k))),
    )
    expect(rows.map((r) => r?.refsKnown)).toEqual([true, undefined])
  })
})

describe('compact', () => {
  test('a segment ingested by another tab but not yet applied is not lost', async () => {
    const base = memoryStore()
    const locks = memoryLocks()
    const tabA = createLocalLog({ store: base, locks, clock: virtualClock(), rng: seededRng(4) })
    const tabB = createLocalLog({ store: base, locks, clock: virtualClock(), rng: seededRng(4) })
    const { doc, flush } = editor(tabA)
    doc.getMap('m').set('mine', 1)
    await flush()
    await tabA.seal()
    const seg = foreignSegment('other', 0, (d) => d.getMap('m').set('theirs', 2))
    await tabB.ingest(seg.key, seg.bytes)
    await tabA.compact()
    await tabA.compact()
    const out = await tabA.load()
    expect(out.updates.length).toBe(1)
    expect(rebuild(out.updates).getMap('m').toJSON()).toEqual({ mine: 1, theirs: 2 })
    expect(await tabA.bytes(seg.key)).toEqual(seg.bytes)
  })

  test('compacting an empty log writes an empty snapshot once', async () => {
    const { log, store } = setup()
    await log.compact()
    expect(await store.read(['snapshot'], (tx) => tx.count('snapshot'))).toBe(1)
    expect((await log.load()).through).toBe(0)
  })
})

describe('clone detection', () => {
  test('an unknown segment under my own deviceId ⇒ new deviceId, seq restarts', async () => {
    const clones: [string, string][] = []
    const { log } = setup({ onClone: (a, b) => clones.push([a, b]) })
    const me = await log.deviceId()
    const { doc, flush } = editor(log)
    doc.getMap('m').set('a', 1)
    await flush()
    const mine = await log.seal()
    expect(await log.ingest(mine?.key ?? '', (await log.bytes(mine?.key ?? '')) ?? new Uint8Array())).toBe('duplicate')
    const twin = foreignSegment(me, 1, (d) => d.getMap('m').set('twin', 1))
    await log.ingest(twin.key, twin.bytes)
    const next = await log.deviceId()
    expect(next).not.toBe(me)
    expect(clones).toEqual([[me, next]])
    doc.getMap('m').set('b', 2)
    await flush()
    expect((await log.seal())?.header).toMatchObject({ deviceId: next, seq: 0 })
  })
})

describe('locks', () => {
  test('an unavailable log lock is an error, never a silent skip', async () => {
    const never: Locks = { run: async () => null }
    const { log } = setup({ locks: never })
    await expect(log.seal()).rejects.toThrow('cursus:log')
  })
})

describe('origins', () => {
  test('REMOTE, TAB and REPLAY are not captured; local edits and undo are', async () => {
    expect([REMOTE, TAB, REPLAY].map(shouldCapture)).toEqual([false, false, false])
    expect(shouldCapture(null)).toBe(true)
    const doc = new Y.Doc()
    const got: Uint8Array[] = []
    const errors: unknown[] = []
    let fail = false
    const stop = captureUpdates(
      doc,
      async (u) => {
        if (fail) throw new Error('quota')
        got.push(u)
      },
      (e) => errors.push(e),
    )
    const undo = new Y.UndoManager(doc.getMap('m'))
    doc.getMap('m').set('a', 1)
    Y.transact(doc, () => doc.getMap('m').set('r', 1), REMOTE)
    Y.transact(doc, () => doc.getMap('m').set('t', 1), TAB)
    undo.undo()
    await Bun.sleep(0) // appends are serialised: the second starts once the first is acknowledged
    expect(got.length).toBe(2)
    fail = true
    doc.getMap('m').set('b', 1)
    await Bun.sleep(0)
    expect(errors.length).toBe(1)
    stop()
    doc.getMap('m').set('c', 1)
    await Bun.sleep(0)
    expect(got.length).toBe(2)
    expect(errors.length).toBe(1)
  })

  test('appends are serialised: a failed update and every later one stay in memory until a retry succeeds', async () => {
    const doc = new Y.Doc()
    let failures = 1
    const persisted: Uint8Array[] = []
    const errors: unknown[] = []
    const timers: { fn: () => void; ms: number }[] = []
    const acks: Promise<void>[] = []
    let changes = 0
    const cap = captureUpdates(
      doc,
      async (u) => {
        if (failures-- > 0) throw new Error('quota')
        persisted.push(u)
      },
      {
        onError: (e) => errors.push(e),
        onQueued: (p) => acks.push(p),
        onChange: () => changes++,
        setTimer: (fn, ms) => {
          timers.push({ fn, ms })
          return () => {}
        },
      },
    )
    doc.getMap('m').set('u1', 1)
    doc.getMap('m').set('u2', 2)
    await cap.settled()
    // U2 must never be persisted before U1: nothing is written while U1 is unacknowledged.
    expect(persisted).toEqual([])
    expect({ unsaved: cap.unsaved(), blocked: cap.blocked(), errors: errors.length }).toEqual({
      unsaved: 2,
      blocked: true,
      errors: 1,
    })
    expect(changes).toBeGreaterThan(0)
    expect(timers.length).toBe(1)
    timers[0]?.fn()
    await cap.settled()
    await Promise.all(acks)
    expect(rebuild(persisted).getMap('m').toJSON()).toEqual({ u1: 1, u2: 2 })
    expect({ unsaved: cap.unsaved(), blocked: cap.blocked() }).toEqual({ unsaved: 0, blocked: false })
    // Repeated failures back off longer; a manual retry does not wait for the timer.
    failures = 2
    doc.getMap('m').set('u3', 3)
    await cap.settled()
    timers[1]?.fn()
    await cap.settled()
    expect((timers[2]?.ms ?? 0) > (timers[1]?.ms ?? 0)).toBe(true)
    await cap.retry()
    expect(cap.unsaved()).toBe(0)
    expect(persisted.length).toBe(3)
    // Stopping with an unacknowledged update rejects its acknowledgment: it was never saved.
    failures = 1
    doc.getMap('m').set('u4', 4)
    await cap.settled()
    const last = acks.at(-1)
    cap.stop()
    await expect(last).rejects.toBeInstanceOf(CaptureStoppedError)
    expect(cap.unsaved()).toBe(1)
  })
})

describe('held (sync guard)', () => {
  const holdAll = async () => ({ hold: true, writes: [{ put: 'kv' as const, key: 'marker', value: 1 }] })

  test('a held segment is stored but neither loaded, replayed, compacted nor listed by since()', async () => {
    const { log, store } = setup()
    const a = foreignSegment('peer', 0, (d) => d.getMap('m').set('a', 1), 51)
    const b = foreignSegment('peer', 1, (d) => d.getMap('m').set('b', 2), 52)
    const asked: string[] = []
    const ok = await log.ingest(a.key, a.bytes, async (s) => {
      asked.push(s.header.deviceId)
      expect(s.key).toBe(a.key)
      expect(Y.decodeUpdateV2(s.update).structs.length).toBeGreaterThan(0)
      return { hold: false }
    })
    expect(ok).toMatchObject({ state: 'applied' })
    const held = await log.ingest(b.key, b.bytes, holdAll)
    expect(held).toMatchObject({ state: 'held', arrival: 2 })
    expect(asked).toEqual(['peer'])
    // The gate's writes land with the row.
    expect(await store.read(['kv'], (tx) => tx.get('kv', 'marker'))).toBe(1)
    expect(
      rebuild((await log.load()).updates)
        .getMap('m')
        .toJSON(),
    ).toEqual({ a: 1 })
    expect((await log.since(0)).map((r) => r.rec.key)).toEqual([a.key])
    expect((await log.keys()).has(b.key)).toBe(true)
    expect(await log.bytes(b.key)).toEqual(b.bytes)
    await log.compact()
    const snap = await store.read(['snapshot'], (tx) => tx.get<{ through: number }>('snapshot', 'main'))
    expect(snap?.through).toBe(1)
    const list = await log.held()
    expect(list.map((h) => [h.rec.key, h.rec.state, h.heldAt])).toEqual([[b.key, 'held', 5000]])
    expect(
      rebuild([list[0]?.update ?? new Uint8Array()])
        .getMap('m')
        .toJSON(),
    ).toEqual({ b: 2 })
  })

  test('the gate is not asked about what cannot be applied, nor about a duplicate', async () => {
    const { log } = setup()
    let asked = 0
    const gate = async () => {
      asked++
      return { hold: true }
    }
    const seg = foreignSegment('peer', 0, (d) => d.getMap('m').set('a', 1))
    const notYjs = encode(
      { v: 1, kind: 'seg', deviceId: 'peer', seq: 1, createdAt: 1, blobRefs: [] },
      new Uint8Array([9, 9, 9]),
    )
    expect(await log.ingest(notYjs.key, notYjs.bytes, gate)).toMatchObject({ state: 'needs-upgrade' })
    expect(asked).toBe(0)
    expect(await log.ingest(seg.key, seg.bytes, gate)).toMatchObject({ state: 'held' })
    expect(await log.ingest(seg.key, seg.bytes, gate)).toBe('duplicate')
    expect(asked).toBe(1)
  })

  test('release marks held rows applied in arrival order, ignores the rest, and survives a reload', async () => {
    const { log, store, locks } = setup()
    const a = foreignSegment('peer', 0, (d) => d.getMap('m').set('a', 1), 51)
    const b = foreignSegment('peer', 1, (d) => d.getMap('m').set('b', 2), 52)
    const c = foreignSegment('other', 0, (d) => d.getMap('m').set('c', 3), 53)
    await log.ingest(a.key, a.bytes, holdAll)
    await log.ingest(b.key, b.bytes, holdAll)
    await log.ingest(c.key, c.bytes)
    const reloaded = createLocalLog({ store, locks, clock: virtualClock(9000), rng: seededRng(2) })
    expect((await reloaded.held()).map((h) => h.rec.key)).toEqual([a.key, b.key])
    expect(
      rebuild((await reloaded.load()).updates)
        .getMap('m')
        .toJSON(),
    ).toEqual({ c: 3 })
    const out = await reloaded.release(
      [b.key, c.key, a.key, 'seg/none/0000000000-0000000000000000.seg'],
      [{ put: 'kv', key: 'after', value: 2 }],
    )
    expect(out.map((r) => [r.key, r.state])).toEqual([
      [a.key, 'applied'],
      [b.key, 'applied'],
    ])
    expect(await store.read(['kv'], (tx) => tx.get('kv', 'after'))).toBe(2)
    expect(await reloaded.held()).toEqual([])
    const row = await store.read(['segments'], (tx) => tx.get<SegmentRow>('segments', a.key))
    expect(row?.heldAt).toBeUndefined()
    expect(
      rebuild((await reloaded.load()).updates)
        .getMap('m')
        .toJSON(),
    ).toEqual({ a: 1, b: 2, c: 3 })
    expect((await reloaded.since(0)).map((r) => r.rec.key)).toEqual([a.key, b.key, c.key])
  })
})
