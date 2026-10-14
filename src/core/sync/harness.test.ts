import { expect, test } from 'bun:test'
import * as Y from 'yjs'
import type { Sealer } from '../contracts/log'
import type { LocalStore, StoreName } from '../contracts/ports'
import type { Entry, RemoteStore } from '../contracts/remote'
import { blobRef, blobStore } from '../log/blobs'
import { sha256Hex } from '../log/codec'
import { createLocalLog } from '../log/localLog'
import { shouldCapture } from '../log/origins'
import { createWorkspace } from '../model/workspace'
import type { VirtualClock } from '../ports/clock'
import { virtualClock } from '../ports/clock'
import { memoryLocks } from '../ports/locks'
import { seededRng } from '../ports/rng'
import { STORE_NAMES } from '../storage/idbStore'
import { memoryStore } from '../storage/memoryStore'
import {
  createSyncEngine,
  type DestKeyring,
  KeyUnavailableError,
  ObjectIntegrityError,
  type SyncEngineOptions,
} from './engine'
import { MemoryBucket, memoryRemote } from './providers/memory'

/** Test-only sealing: "CRSE" | keyId | xor. Exercises the engine's sealed paths without real crypto. */
export const FAKE_MAGIC = [0x43, 0x52, 0x53, 0x45]
export const fakeSealer: Sealer = {
  async seal(k, _key, plain) {
    const cur = await k.current()
    if (!cur) throw new KeyUnavailableError('none')
    return new Uint8Array([...FAKE_MAGIC, cur.id.charCodeAt(0), ...plain.map((b) => b ^ 0x2a)])
  },
  async open(k, _key, body) {
    if (FAKE_MAGIC.some((b, i) => body[i] !== b)) throw new ObjectIntegrityError('not sealed')
    const id = String.fromCharCode(body[4] ?? 0)
    if (!(await k.byId(id))) throw new KeyUnavailableError(id)
    return body.slice(5).map((b) => b ^ 0x2a)
  },
}

/** Fake envelope of a fake key: `keys/<sha256>.json` naming its key id, like a real one. */
export function fakeEnvelope(id: string): { key: string; body: Uint8Array } {
  const body = new TextEncoder().encode(JSON.stringify({ v: 1, fake: id }))
  return { key: `keys/${sha256Hex(body)}.json`, body }
}

export async function fakeKeyring(id = 'a', unlocked = true): Promise<DestKeyring & { unlock(): void }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  let open = unlocked
  const learned: string[] = []
  const envelope = fakeEnvelope(id)
  const ring: DestKeyring & { unlock(): void; learn(files: { key: string }[]): Promise<void>; learned: string[] } = {
    learned,
    async current() {
      return open ? { id, key } : null
    },
    async byId(x) {
      return open && x === id ? key : null
    },
    unlock() {
      open = true
    },
    async learn(files) {
      for (const f of files) learned.push(f.key)
    },
    async files() {
      return [envelope]
    },
    keyIdOf(f) {
      try {
        const x: unknown = JSON.parse(new TextDecoder().decode(f.body))
        return typeof x === 'object' && x !== null && 'fake' in x && typeof x.fake === 'string' ? x.fake : null
      } catch (e) {
        if (e instanceof SyntaxError) return null // not a fake envelope
        throw e
      }
    },
  }
  return ring
}

export async function all(it: AsyncIterable<Entry>): Promise<Entry[]> {
  const out: Entry[] = []
  for await (const e of it) out.push(e)
  return out
}

/** Copies every table of a memory store (a cloned replica, e.g. a restored backup of the whole profile). */
export async function cloneStore(src: LocalStore): Promise<LocalStore> {
  const dst = memoryStore()
  for (const name of STORE_NAMES as StoreName[]) {
    const [keys, values] = await src.read([name], (tx) => Promise.all([tx.getAllKeys(name), tx.getAll(name)]))
    await dst.commit(keys.map((key, i) => ({ put: name, key, value: values[i] })))
  }
  return dst
}

export interface TestDevice {
  store: LocalStore
  log: ReturnType<typeof createLocalLog>
  blobs: ReturnType<typeof blobStore>
  doc: Y.Doc
  ws: ReturnType<typeof createWorkspace>
  engine: ReturnType<typeof createSyncEngine>
  /** Waits for captured edits to reach `pending`, then seals them into a segment. */
  commit(): Promise<void>
  attach(data: Uint8Array): Promise<string>
}

export async function device(
  seed: number,
  clock: VirtualClock,
  o: Partial<SyncEngineOptions> & { store?: LocalStore; clones?: [string, string][] } = {},
): Promise<TestDevice> {
  const store = o.store ?? memoryStore()
  const locks = o.locks ?? memoryLocks()
  const rng = seededRng(seed, clock)
  const log = createLocalLog({ store, locks, clock, rng, onClone: (a, b) => o.clones?.push([a, b]) })
  const blobs = blobStore(store)
  const doc = new Y.Doc()
  doc.clientID = rng.u32() // fresh per session, never persisted
  const writes: Promise<void>[] = []
  doc.on('updateV2', (u: Uint8Array, origin: unknown) => {
    if (shouldCapture(origin)) writes.push(log.appendLocal(u))
  })
  for (const u of (await log.load()).updates) Y.applyUpdateV2(doc, u, Symbol('load'))
  const ws = createWorkspace(doc, { rng, clock, deviceId: await log.deviceId() })
  const engine = createSyncEngine({ store, log, blobs, locks, clock, rng, doc, checkpointEvery: 0, ...o })
  return {
    store,
    log,
    blobs,
    doc,
    ws,
    engine,
    async commit() {
      await Promise.all(writes)
      await log.seal()
    },
    async attach(data) {
      const id = await blobs.put(data, 'application/octet-stream')
      const course = ws.courses.list()[0]?.id ?? ws.courses.create({ title: 'files' })
      ws.sources.create({ courseId: course, kind: 'pdf', title: 'file', blobId: blobRef(id) })
      return id
    },
  }
}

export function world(seed = 1) {
  const clock = virtualClock(1_700_000_000_000)
  const bucket = new MemoryBucket(clock)
  return {
    clock,
    bucket,
    remote: (prefix = 'd1', pageSize?: number): RemoteStore & { calls: { list: number; get: number; put: number } } =>
      memoryRemote({ bucket, prefix, pageSize }),
    seed,
  }
}

test('harness: a device captures, seals and loads back', async () => {
  const w = world()
  const a = await device(1, w.clock)
  a.ws.courses.create({ title: 'Bio' })
  await a.commit()
  expect((await a.log.keys()).size).toBe(1)
  const again = await device(9, virtualClock(), { store: a.store })
  expect(again.ws.courses.list().map((c) => c.title)).toEqual(['Bio'])
  const copy = await cloneStore(a.store)
  expect(
    (await createLocalLog({ store: copy, locks: memoryLocks(), clock: w.clock, rng: seededRng(2) }).keys()).size,
  ).toBe(1)
  expect(
    await fakeSealer.open(
      await fakeKeyring(),
      'k',
      await fakeSealer.seal(await fakeKeyring(), 'k', new Uint8Array([1])),
    ),
  ).toEqual(new Uint8Array([1]))
})
