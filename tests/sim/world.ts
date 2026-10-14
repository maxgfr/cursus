import type fc from 'fast-check'
import * as Y from 'yjs'
import type { LocalStore, Rng, StoreName } from '../../src/core/contracts/ports'
import type { Entry, Key, RemoteStore } from '../../src/core/contracts/remote'
import { createKeyring, type DestinationKeyring, type KeyFile } from '../../src/core/crypto/keyring'
import { createSealer } from '../../src/core/crypto/sealer'
import { blobStore } from '../../src/core/log/blobs'
import { createLocalLog, type LocalLogImpl } from '../../src/core/log/localLog'
import { type Capture, CaptureStoppedError, captureUpdates, REPLAY, TAB } from '../../src/core/log/origins'
import { createWorkspace, type ModelWorkspace } from '../../src/core/model/workspace'
import { virtualClock } from '../../src/core/ports/clock'
import { memoryLocks } from '../../src/core/ports/locks'
import { seededRng } from '../../src/core/ports/rng'
import { LocalQuotaError, STORE_NAMES } from '../../src/core/storage/idbStore'
import { memoryStore } from '../../src/core/storage/memoryStore'
import { secretsVault } from '../../src/core/storage/secrets'
import { createSyncEngine, type SyncEngineImpl } from '../../src/core/sync/engine'
import { type FaultyRemote, faultyRemote } from '../../src/core/sync/providers/faulty'
import { MemoryBucket, memoryRemote } from '../../src/core/sync/providers/memory'
import { InvariantError } from './invariants'
import { Oracle } from './oracle'

/** The device process died: every operation of that generation fails from now on. */
export class CrashError extends Error {
  constructor(device: string) {
    super(`crash: ${device}`)
    this.name = 'CrashError'
  }
}

export const PBKDF2_TEST_ITERATIONS = 1000

export interface SimParams {
  seed: number
  dests: number
  /** Per device: bit i set ⇒ connected to destination i (fixed up so the graph is connected). */
  links: number[]
  tabs: number[]
  pageSize: number
  checkpointEvery: number
}

export interface SimDest {
  name: string
  prefix: string
  sealed: boolean
  /** False while a sealed copy is being made (or if making it failed): no device adopts it then. */
  ready: boolean
  passphrase?: string
  keyFile?: KeyFile
}

export class SimTab {
  readonly doc = new Y.Doc()
  readonly ws: ModelWorkspace
  /** The app's capture path: one ordered queue per doc, failed appends kept in memory and retried. */
  readonly capture: Capture
  last = 0
  lastWrite: Promise<void> | null = null
  private chain: Promise<void> = Promise.resolve()
  private readonly onAck = new Map<Promise<void>, () => void>()
  /** Capture order of updates in flight, and how many were acknowledged (in order) so far. */
  private readonly order = new Map<Uint8Array, number>()
  private captured = 0
  private acked = 0

  constructor(
    private readonly dev: SimDevice,
    clientID: number,
    deviceId: string,
  ) {
    this.doc.clientID = clientID
    this.capture = captureUpdates(this.doc, (u) => this.append(u), {
      onError: (e) => dev.world.expected(e),
      onQueued: (p) => {
        this.lastWrite = p
        p.then(
          () => {
            this.onAck.get(p)?.()
            this.onAck.delete(p)
          },
          (e: unknown) => {
            this.onAck.delete(p)
            dev.world.expected(e)
          },
        )
      },
      // Retries are driven by the simulation (end of each step, heal), never by wall-clock timers.
      setTimer: () => () => {},
    })
    this.ws = createWorkspace(this.doc, { rng: dev.world.rng, clock: dev.clock, deviceId })
  }

  /**
   * Appends in capture order, checked: the log may acknowledge update N only once every earlier update
   * of this tab was acknowledged — otherwise a crash would keep N without the structs it builds on.
   */
  private async append(u: Uint8Array): Promise<void> {
    let n = this.order.get(u)
    if (n === undefined) {
      n = this.captured++
      this.order.set(u, n)
    }
    await this.dev.log.appendLocal(u)
    this.order.delete(u)
    if (n !== this.acked) {
      this.dev.world.unexpected(
        new InvariantError('I5', `${this.dev.name}: update ${n} saved while update ${this.acked} is not`),
      )
    }
    this.acked = Math.max(this.acked, n + 1)
  }

  /** Runs `fn` once the log acknowledged `ack` (maybe much later, after retries); never if it is lost. */
  whenAcked(ack: Promise<void>, fn: () => void): void {
    this.onAck.set(ack, fn)
  }

  async load(): Promise<void> {
    const { updates, through } = await this.dev.log.load()
    Y.transact(
      this.doc,
      () => {
        for (const u of updates) Y.applyUpdateV2(this.doc, u)
      },
      REPLAY,
    )
    this.last = through
  }

  /** BroadcastChannel hint received: re-read `since()` and apply with origin TAB. */
  sync(): Promise<void> {
    const run = async (): Promise<void> => {
      const rows = await this.dev.log.since(this.last)
      Y.transact(
        this.doc,
        () => {
          for (const r of rows) Y.applyUpdateV2(this.doc, r.update)
        },
        TAB,
      )
      for (const r of rows) this.last = Math.max(this.last, r.rec.arrival)
    }
    const next = this.chain.then(run)
    this.chain = next.catch((e: unknown) => this.dev.world.unexpected(e))
    return next
  }
}

export class SimDevice {
  gen = 0
  dead = false
  crashIn: number | null = null
  offset = 0
  lossy = false
  /** Local-quota fault: the next N appends to `pending` fail with LocalQuotaError (transient). */
  localQuota = 0
  readonly locks = memoryLocks()
  readonly dests = new Set<string>()
  /** Sealed destinations this device added WITHOUT the `sealed` hint: it must find out by itself. */
  readonly unhinted = new Set<string>()
  readonly faults = new Map<string, FaultyRemote>()
  readonly clock = { now: () => this.world.clock.now() + this.offset }
  store!: LocalStore
  log!: LocalLogImpl
  blobs!: ReturnType<typeof blobStore>
  engine!: SyncEngineImpl
  keyrings = new Map<string, DestinationKeyring>()
  tabs: SimTab[] = []
  readonly clones: [string, string][] = []

  constructor(
    readonly world: World,
    readonly name: string,
    readonly base: LocalStore,
    readonly tabCount: number,
  ) {}

  /** Retries every unacknowledged append now; returns once each queue is empty or blocked again. */
  async flushWrites(): Promise<void> {
    for (const t of this.tabs) await t.capture.retry()
  }

  unsaved(): number {
    return this.tabs.reduce((n, t) => n + t.capture.unsaved(), 0)
  }

  /** Every store and remote call checks the generation: a dead process does nothing more. */
  private alive(gen: number): void {
    if (this.dead || gen !== this.gen) throw new CrashError(this.name)
  }

  /**
   * Like IndexedDB: transactions of one database run in the order they were created (a read sees every
   * write issued before it). The scheduler interleaves them with everything else, never reorders them.
   */
  private tail: Promise<void> = Promise.resolve()

  private wrapStore(gen: number): LocalStore {
    const base = this.base
    const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
      const p = this.tail.then(fn)
      this.tail = p.then(
        () => {},
        () => {},
      )
      return p
    }
    return {
      read: (stores, fn) =>
        enqueue(async () => {
          this.alive(gen)
          return base.read(stores, fn)
        }),
      commit: (ops) =>
        enqueue(async () => {
          this.alive(gen)
          await this.world.sched(`${this.name}:commit`)
          this.alive(gen)
          if (this.localQuota > 0 && ops.some((op) => 'add' in op && op.add === 'pending')) {
            this.localQuota--
            throw new LocalQuotaError('local storage full (injected)')
          }
          // Crashes are armed for the action steps only, never during checks or the heal phase.
          if (this.world.scheduler !== null && this.crashIn !== null && --this.crashIn <= 0) {
            this.crashIn = null
            this.dead = true
            throw new CrashError(this.name)
          }
          return base.commit(ops)
        }),
    }
  }

  faultsFor(dest: string): FaultyRemote {
    let f = this.faults.get(dest)
    if (!f) {
      const d = this.world.dest(dest)
      f = faultyRemote(memoryRemote({ bucket: this.world.bucket, prefix: d.prefix }), { retryAfterMs: 1000 })
      this.faults.set(dest, f)
    }
    return f
  }

  private wrapRemote(gen: number, dest: string): RemoteStore {
    const f = this.faultsFor(dest)
    const sched = (label: string) => this.world.sched(`${this.name}:${dest}:${label}`)
    const alive = () => this.alive(gen)
    return {
      id: f.id,
      list(prefix, o) {
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<Entry> {
            alive()
            await sched('list')
            alive()
            for await (const e of f.list(prefix, o)) {
              alive()
              yield e
            }
          },
        }
      },
      async get(e) {
        alive()
        await sched('get')
        alive()
        const out = await f.get(e)
        alive()
        return out
      },
      async put(key: Key, body: Uint8Array) {
        alive()
        await sched('put')
        alive()
        await f.put(key, body)
      },
    }
  }

  keyringFor(dest: string): DestinationKeyring {
    const d = this.world.dest(dest)
    let k = this.keyrings.get(dest)
    if (!k) {
      k = createKeyring({
        secrets: secretsVault(this.store),
        destId: this.faultsFor(d.name).id,
        rng: this.world.rng,
        iterations: PBKDF2_TEST_ITERATIONS,
      })
      this.keyrings.set(dest, k)
    }
    return k
  }

  /** `hinted` false: a sealed destination added like any bucket — the engine must detect the seal itself. */
  addDest(dest: string, hinted = !this.unhinted.has(dest)): void {
    this.dests.add(dest)
    if (!hinted) this.unhinted.add(dest)
    const d = this.world.dest(dest)
    const remote = this.wrapRemote(this.gen, dest)
    if (!d.sealed) this.engine.addDest({ remote, id: dest })
    else if (hinted) this.engine.addDest({ remote, id: dest, keyring: this.keyringFor(dest), sealed: true })
    else this.engine.addDest({ remote, id: dest, keyring: this.keyringFor(dest) })
  }

  /** (Re)starts the app on this device: new log, engine and tabs over the same storage. */
  async boot(): Promise<void> {
    this.gen++
    this.dead = false
    this.crashIn = null
    const gen = this.gen
    this.store = this.wrapStore(gen)
    const rng = this.world.rng
    this.log = createLocalLog({
      store: this.store,
      locks: this.locks,
      clock: this.clock,
      rng,
      onClone: (a, b) => this.clones.push([a, b]),
    })
    this.blobs = blobStore(this.store)
    this.keyrings = new Map()
    // The previous process is gone: whatever its tabs had not saved is lost (never acknowledged).
    for (const t of this.tabs) t.capture.stop()
    const deviceId = await this.log.deviceId()
    this.tabs = []
    for (let i = 0; i < this.tabCount; i++) this.tabs.push(new SimTab(this, rng.u32(), deviceId))
    for (const t of this.tabs) await t.load()
    const first = this.tabs[0] as SimTab
    this.engine = createSyncEngine({
      store: this.store,
      log: this.log,
      blobs: this.blobs,
      locks: this.locks,
      clock: this.clock,
      rng,
      doc: first.doc,
      sealer: createSealer(rng),
      onIngested: (arrival) => this.hint(arrival),
      confirmWorkspace: async () => true,
      pageSize: this.world.params.pageSize,
      checkpointEvery: this.world.params.checkpointEvery,
      unsaved: () => this.unsaved(),
    })
    for (const d of [...this.dests].sort()) this.addDest(d)
  }

  /** Lossy BroadcastChannel: each tab may miss a hint; the next one catches it up. */
  hint(_arrival: number): void {
    for (const t of this.tabs) {
      if (this.lossy && this.world.rng.u32() % 2 === 0) continue
      void t.sync().catch((e: unknown) => this.world.expected(e))
    }
  }

  /** Local objects: segments, checkpoints, chunks, manifests (read without the crash wrapper). */
  async localKeys(): Promise<Set<Key>> {
    const [a, b, c] = await this.base.read(['segments', 'chunks', 'bmans'], (tx) =>
      Promise.all([tx.getAllKeys('segments'), tx.getAllKeys('chunks'), tx.getAllKeys('bmans')]),
    )
    return new Set([...a, ...b, ...c].map(String))
  }
}

export class World {
  readonly clock = virtualClock(1_700_000_000_000)
  readonly bucket = new MemoryBucket(this.clock)
  readonly rng: Rng
  readonly oracle = new Oracle()
  readonly destList: SimDest[] = []
  readonly devices: SimDevice[] = []
  scheduler: fc.Scheduler | null = null
  /** Errors nobody expected: the property fails on any of them. */
  readonly errors: unknown[] = []
  /** Expected, absorbed failures (crashes, remote errors) — counted for the report. */
  absorbed = 0
  private nextDevice = 0
  sealedCount = 0

  constructor(readonly params: SimParams) {
    this.rng = seededRng(params.seed, this.clock)
  }

  sched(label: string): Promise<void> {
    return this.scheduler ? this.scheduler.schedule(Promise.resolve(), label) : Promise.resolve()
  }

  /** Crashes, injected local-quota failures and the edits a crash lost are part of the model. */
  expected(e: unknown): void {
    if (e instanceof CrashError || e instanceof LocalQuotaError || e instanceof CaptureStoppedError) this.absorbed++
    else this.unexpected(e)
  }

  unexpected(e: unknown): void {
    if (e instanceof CrashError) {
      this.absorbed++
      return
    }
    this.errors.push(e)
  }

  dest(name: string): SimDest {
    const d = this.destList.find((x) => x.name === name)
    if (!d) throw new RangeError(`unknown destination ${name}`)
    return d
  }

  async addDevice(
    base: LocalStore,
    tabs: number,
    dests: Iterable<string>,
    unhinted: Iterable<string> = [],
  ): Promise<SimDevice> {
    const dev = new SimDevice(this, `dev${this.nextDevice++}`, base, tabs)
    for (const d of dests) dev.dests.add(d)
    for (const d of unhinted) dev.unhinted.add(d)
    await dev.boot()
    this.devices.push(dev)
    return dev
  }

  static async create(params: SimParams): Promise<World> {
    const w = new World(params)
    for (let i = 0; i < params.dests; i++)
      w.destList.push({ name: `d${i}`, prefix: `r${i}`, sealed: false, ready: true })
    const links = params.links.map((m) => m & ((1 << params.dests) - 1))
    const connected = (ls: number[]): boolean => {
      const seen = new Set<number>([0])
      let grew = true
      while (grew) {
        grew = false
        for (const m of ls) {
          const ds = [...Array(params.dests).keys()].filter((i) => (m >> i) & 1)
          if (ds.some((i) => seen.has(i)) && ds.some((i) => !seen.has(i))) {
            for (const i of ds) seen.add(i)
            grew = true
          }
        }
      }
      return ls.every((m) => m !== 0) && seen.size === params.dests && ls.some((m) => m & 1)
    }
    const fixed = links.map((m) => (m === 0 ? 1 : m))
    if (!connected(fixed)) fixed[0] = (1 << params.dests) - 1
    for (let i = 0; i < fixed.length; i++) {
      const m = fixed[i] ?? 1
      await w.addDevice(
        memoryStore(),
        params.tabs[i] ?? 1,
        w.destList.filter((_, j) => (m >> j) & 1).map((d) => d.name),
      )
    }
    return w
  }

  /** Atomic copy of a device's whole profile (a cloned backup, a copied browser profile…). */
  static async copyStore(src: LocalStore): Promise<LocalStore> {
    const names = STORE_NAMES as StoreName[]
    const tables = await src.read(names, (tx) =>
      Promise.all(names.map((n) => Promise.all([tx.getAllKeys(n), tx.getAll(n)]))),
    )
    const dst = memoryStore()
    await dst.commit(
      names.flatMap((n, i) => (tables[i]?.[0] ?? []).map((key, j) => ({ put: n, key, value: tables[i]?.[1][j] }))),
    )
    return dst
  }

  liveDevices(): SimDevice[] {
    return this.devices
  }
}
