import * as Y from 'yjs'
import { EnvelopeError, RemoteError, type RemoteErrorKind } from '../contracts/errors'
import type { BlobStore, EnvelopeCodec, Header, Keyring, LocalLog, Sealer } from '../contracts/log'
import type { Clock, LocalStore, Locks, Rng } from '../contracts/ports'
import type { Entry, Key, RemoteStore } from '../contracts/remote'
import type { DestState, SyncEngine } from '../contracts/sync'
import { blobStore, parseManifest } from '../log/blobs'
import { blobKey, bmanKey, codec as defaultCodec, MAGIC, parseKey } from '../log/codec'
import { createLocalLog, type SegmentRow } from '../log/localLog'
import { REPLAY } from '../log/origins'
import { memoryLocks } from '../ports/locks'
import { memoryStore } from '../storage/memoryStore'
import { buildCheckpoint, CHECKPOINT_EVERY, persistedDoc } from './checkpoints'
import { syncLockName } from './identity'
import {
  confirmByListing,
  FULL_LISTING_EVERY_MS,
  type IncrementalMode,
  type Listing,
  planListing,
  runListing,
} from './listing'
import { computeStatus, type DestRuntime, type EngineStatus } from './status'
import { canonicalState, diffCanonical, FMT_KEY, FMT_V1, hashMatches, verifyPass } from './verify'

/** A sealed object names a key this device has not unlocked: the destination needs the passphrase. */
export class KeyUnavailableError extends Error {
  constructor(readonly keyId: string) {
    super(`Key ${keyId} is not unlocked on this device`)
    this.name = 'KeyUnavailableError'
  }
}

/** An object that does not open to valid content (tampered, truncated, moved to another key…). */
export class ObjectIntegrityError extends Error {
  constructor(m: string) {
    super(m)
    this.name = 'ObjectIntegrityError'
  }
}

export interface DestKeyring extends Keyring {
  /** Receives the destination's key envelopes (`keys/*.json`) so a passphrase can unlock them later. */
  learn?(files: { key: Key; body: Uint8Array }[]): Promise<void>
  /** Envelopes known on this device: a synced set, uploaded and confirmed before any sealed object. */
  files?(): Promise<{ key: Key; body: Uint8Array }[]>
  /** Key id an envelope wraps; null when it is not an envelope this build reads. */
  keyIdOf?(file: { key: Key; body: Uint8Array }): string | null
}

export interface DestConfig {
  remote: RemoteStore
  /** Defaults to remote.id (the identity hash). */
  id?: string
  label?: string
  keyring?: DestKeyring
  /** Created as sealed (known before any listing): never send it plaintext, even if `keys/` is not seen. */
  sealed?: boolean
  incremental?: IncrementalMode
  paused?: boolean
}

export interface SyncEngineOptions {
  store: LocalStore
  log: LocalLog & { deviceId(): Promise<string> }
  blobs: BlobStore
  locks: Locks
  clock: Clock
  rng: Rng
  codec?: EnvelopeCodec
  sealer?: Sealer
  /** Live doc downloaded updates are applied to, with origin REPLAY (never captured again). */
  doc?: Y.Doc
  /** BroadcastChannel hint: other tabs re-read `since()` from this arrival. */
  onIngested?: (arrival: number) => void
  /** A different `ws/` meets a non-empty local library: merging cannot be undone, so ask. */
  confirmWorkspace?: (q: { dest: string; local: string | null; remote: string[] }) => Promise<boolean>
  pageSize?: number
  /** Uncovered segments before a checkpoint is built; 0 disables automatic checkpoints. */
  checkpointEvery?: number
  /** A key whose every copy fails verification this many rounds is reported as corrupt. */
  maxHashFailures?: number
  /** A PUT not confirmed after this long is sent again. */
  awaitingMs?: number
  /** Captured edits the local log has not acknowledged yet (`Capture.unsaved()` of every doc). */
  unsaved?: () => number
}

export interface RoundResult {
  down: number
  up: number
  deferred: number
}

export interface SyncEngineImpl extends SyncEngine {
  status(): EngineStatus
  subscribe(fn: (s: EngineStatus) => void): () => void
  addDest(cfg: DestConfig): string
  removeDest(id: string): void
  setPaused(id: string, paused: boolean): void
  destIds(): string[]
  /** Scheduler feedback: backoff until `nextTryAt` (undefined clears it). */
  noteSchedule(id: string, nextTryAt: number | undefined): void
  /** Recomputes the status from storage and notifies subscribers. */
  refresh(): Promise<EngineStatus>
  /** Builds a checkpoint now if any applied segment is uncovered. */
  checkpoint(): Promise<Key | null>
  workspaceId(): Promise<string | null>
}

/** Persisted per destination in the `dests` store. */
interface DestMeta {
  id: string
  confirmed: Record<Key, number>
  awaiting: Record<Key, number>
  failures: Record<Key, number>
  /** Seen sealed (keys/ listed, or configured so): permanent, never downgraded to plaintext. */
  sealed: boolean
  /** Proven plaintext: it holds an object in the clear, or this device initialised it empty. */
  plain?: boolean
  /** Key ids this device sealed objects with here: each needs its envelope confirmed here. */
  usedKeys?: string[]
  /** Some local envelope (or one for a used key id) is not confirmed here: nothing is protected here. */
  keyGap?: boolean
  /** Envelopes read back intact here (cleared when a full listing no longer shows them). */
  keysRead?: Record<Key, true>
  /** Plaintext only: our fmt/v1 and ws/ markers were read back intact (a damaged one is put again). */
  markersOk?: boolean
  lastFullAt?: number
  lastListedAt?: number
  lastOkAt?: number
  lastVerifiedAt?: number
  verifyCursor?: Key
}

interface Dest {
  cfg: DestConfig
  rt: DestRuntime
}

interface Inventory {
  log: Set<Key>
  chunks: Set<Key>
  bmans: Set<Key>
}

type Fetched = 'ok' | 'absent' | 'bad' | 'no-key'
type Sealedness = 'sealed' | 'plain' | 'unknown'

export const AWAITING_MS = 10 * 60 * 1000
export const MAX_HASH_FAILURES = 3

const STATE_FOR: Record<RemoteErrorKind, DestState> = {
  auth: 'needs-auth',
  permission: 'needs-permission',
  network: 'backoff',
  cors: 'error',
  quota: 'error',
  'rate-limited': 'backoff',
  'clock-skew': 'backoff',
}

/** Reads the state afresh (it changes across awaits). */
const stateOf = (d: Dest): DestState => d.rt.state
const metaKey = (id: string): string => `state:${id}`
const ZERO: RoundResult = { down: 0, up: 0, deferred: 0 }

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

const isData = (key: Key): boolean => {
  const k = parseKey(key)?.kind
  return k === 'seg' || k === 'ckpt' || k === 'blob' || k === 'bman'
}
const isKeyFile = (key: Key): boolean => parseKey(key)?.kind === 'keys'

/** Raw remote bytes stored in the clear (a sealed root never holds such an object). */
function inClear(key: Key, body: Uint8Array): boolean {
  if (hashMatches(key, body)) return true
  const kind = parseKey(key)?.kind
  // A damaged plaintext envelope still starts with the envelope magic; a sealed object never does.
  return (kind === 'seg' || kind === 'ckpt') && body.length > MAGIC.length && MAGIC.every((b, i) => body[i] === b)
}

type KeyFileBody = { key: Key; body: Uint8Array }

/**
 * A keyring that only answers for key ids whose envelope the destination itself holds: the device's
 * unlocked DEK is reachable only through an envelope found there (used by the restore drill).
 */
function scopedKeyring(base: DestKeyring, files: KeyFileBody[]): DestKeyring {
  const ids = [...new Set(files.map((f) => base.keyIdOf?.(f) ?? null).filter((x): x is string => x !== null))].sort()
  return {
    async current() {
      for (const id of ids) {
        const key = await base.byId(id)
        if (key) return { id, key }
      }
      return null
    },
    byId: async (id) => (ids.includes(id) ? base.byId(id) : null),
  }
}

export function createSyncEngine(o: SyncEngineOptions): SyncEngineImpl {
  return build(o).engine
}

function build(o: SyncEngineOptions): { engine: SyncEngineImpl; drillRound(id: string): Promise<DestState> } {
  const { store, log, blobs, locks, clock, rng } = o
  const codec = o.codec ?? defaultCodec
  const awaitingMs = o.awaitingMs ?? AWAITING_MS
  const maxFailures = o.maxHashFailures ?? MAX_HASH_FAILURES
  const dests = new Map<string, Dest>()
  const fullDone = new Set<string>()
  const subs = new Set<(s: EngineStatus) => void>()
  /** Headers of applied rows (immutable once applied). */
  const headers = new Map<Key, Header>()
  /** Chunk keys of each manifest (immutable). */
  const manifests = new Map<Key, Key[]>()
  /** Bodies already read this round (proving plaintext): the download uses them instead of a second GET. */
  const prefetched = new WeakMap<Entry, Uint8Array>()
  let cached: EngineStatus = computeStatus({
    now: clock.now(),
    dests: [],
    local: new Set(),
    seen: {},
    unsealed: 0,
    needsUpgrade: 0,
  })

  const emit = (): void => {
    for (const fn of subs) fn(cached)
  }

  const dest = (id: string): Dest => {
    const d = dests.get(id)
    if (!d) throw new RangeError(`Unknown destination ${id}`)
    return d
  }

  const loadMeta = async (id: string): Promise<DestMeta> =>
    (await store.read(['dests'], (tx) => tx.get<DestMeta>('dests', metaKey(id)))) ?? {
      id,
      confirmed: {},
      awaiting: {},
      failures: {},
      sealed: false,
    }
  const saveMeta = (m: DestMeta): Promise<void> => store.commit([{ put: 'dests', key: metaKey(m.id), value: m }])

  const confirm = (m: DestMeta, key: Key): void => {
    m.confirmed[key] = m.confirmed[key] ?? clock.now()
    delete m.awaiting[key]
  }

  const inventory = async (): Promise<Inventory> => {
    const [segs, chunks, bmans] = await store.read(['segments', 'chunks', 'bmans'], (tx) =>
      Promise.all([tx.getAllKeys('segments'), tx.getAllKeys('chunks'), tx.getAllKeys('bmans')]),
    )
    const str = (ks: unknown[]): Set<Key> => new Set(ks.filter((k): k is string => typeof k === 'string'))
    return { log: str(segs), chunks: str(chunks), bmans: str(bmans) }
  }
  const has = (inv: Inventory, key: Key): boolean => inv.log.has(key) || inv.chunks.has(key) || inv.bmans.has(key)

  /**
   * Header of a local log row, read without decoding the update: also for a needs-upgrade row whose
   * header decoded. Null when the header itself is unreadable — its blob refs are unknown.
   */
  const headerOf = async (key: Key): Promise<Header | null> => {
    const known = headers.get(key)
    if (known) return known
    const row = await store.read(['segments'], (tx) => tx.get<SegmentRow>('segments', key))
    if (!row || (row.state !== 'applied' && row.refsKnown !== true)) return null
    // Only applied headers are cached: `refresh` counts the rows missing from the cache as upgrades.
    if (row.state === 'applied') headers.set(key, row.header)
    return row.header
  }

  const chunksOf = async (bman: Key): Promise<Key[] | null> => {
    const known = manifests.get(bman)
    if (known) return known
    const bytes = await blobs.read(bman)
    if (!bytes) return null
    const keys = [...new Set(parseManifest(bytes).chunks)].map(blobKey)
    manifests.set(bman, keys)
    return keys
  }

  /** Local plaintext of a data key. */
  const plainOf = async (key: Key): Promise<Uint8Array | null> => {
    const kind = parseKey(key)?.kind
    if (kind === 'seg' || kind === 'ckpt') return log.bytes(key)
    return blobs.read(key)
  }

  const isSealed = (d: Dest, m: DestMeta): boolean => m.sealed || d.cfg.sealed === true

  const sealerFor = (d: Dest): { sealer: Sealer; keyring: DestKeyring } => {
    if (!o.sealer || !d.cfg.keyring) throw new KeyUnavailableError('none')
    return { sealer: o.sealer, keyring: d.cfg.keyring }
  }

  const openBody = async (d: Dest, sealed: boolean, key: Key, body: Uint8Array): Promise<Uint8Array> => {
    if (!sealed) return body
    const { sealer, keyring } = sealerFor(d)
    return sealer.open(keyring, key, body)
  }

  const putPlain = async (d: Dest, sealed: boolean, key: Key, plain: Uint8Array): Promise<void> => {
    const kind = parseKey(key)?.kind
    // fmt/v1 and key files stay readable; a sealed root's ws/ marker is sealed (an empty one proves plaintext).
    if (!sealed || kind === 'fmt' || kind === 'keys') return d.cfg.remote.put(key, plain)
    const { sealer, keyring } = sealerFor(d)
    return d.cfg.remote.put(key, await sealer.seal(keyring, key, plain))
  }

  const apply = (update: Uint8Array): void => {
    const doc = o.doc
    if (!doc) return
    Y.transact(doc, () => Y.applyUpdateV2(doc, update), REPLAY, false)
  }

  /** Verifies and stores a plaintext object; throws EnvelopeError when it does not match its key. */
  const ingestPlain = async (key: Key, plain: Uint8Array): Promise<void> => {
    const kind = parseKey(key)?.kind
    if (kind === 'seg' || kind === 'ckpt') {
      const rec = await log.ingest(key, plain)
      if (rec === 'duplicate') return
      if (rec.state === 'applied') {
        headers.set(key, rec.header)
        apply(codec.decode(key, plain).update)
      }
      o.onIngested?.(rec.arrival)
      return
    }
    await blobs.ingest(key, plain)
  }

  /** Tries every remote copy of a key until one opens and matches its hash. */
  const fetchInto = async (d: Dest, m: DestMeta, sealed: boolean, key: Key, entries: Entry[]): Promise<Fetched> => {
    const list = entries.length > 0 ? entries : [{ key }]
    let sawBody = false
    for (const e of list) {
      const body = prefetched.get(e) ?? (await d.cfg.remote.get(e))
      prefetched.delete(e)
      if (body === null) continue
      sawBody = true
      let plain: Uint8Array
      try {
        plain = await openBody(d, sealed, key, body)
      } catch (err) {
        if (err instanceof KeyUnavailableError) return 'no-key'
        if (err instanceof ObjectIntegrityError) continue // damaged copy: another duplicate may be intact
        throw err
      }
      try {
        await ingestPlain(key, plain)
      } catch (err) {
        if (err instanceof EnvelopeError) continue // copy does not match its key: try the next one
        throw err
      }
      delete m.failures[key]
      confirm(m, key)
      return 'ok'
    }
    if (!sawBody) return 'absent'
    m.failures[key] = (m.failures[key] ?? 0) + 1
    return 'bad'
  }

  /** "Fetch it elsewhere first": a file a segment needs, from any other destination. */
  const fetchElsewhere = async (except: string, key: Key): Promise<boolean> => {
    for (const [id, d] of dests) {
      if (id === except) continue
      const m = await loadMeta(id)
      const sealed = isSealed(d, m)
      let got: Fetched
      try {
        got = await fetchInto(d, m, sealed, key, [])
      } catch (err) {
        // That other destination is unreachable right now: it is simply not a source this time.
        if (err instanceof RemoteError) continue
        throw err
      }
      if (got === 'ok') return true
    }
    return false
  }

  const workspaceGuard = async (d: Dest, remoteWs: string[], readOnly: boolean): Promise<string | null | false> => {
    const [local, aliases, segs, pending] = await store.read(['kv', 'segments', 'pending'], (tx) =>
      Promise.all([
        tx.get<string>('kv', 'workspaceId'),
        tx.get<string[]>('kv', 'workspaceAliases'),
        tx.count('segments'),
        tx.count('pending'),
      ]),
    )
    if (readOnly) return local ?? null
    const accepted = new Set([...(aliases ?? []), ...(local === undefined ? [] : [local])])
    const foreign = remoteWs.filter((w) => !accepted.has(w)).sort()
    if (foreign.length === 0) {
      if (local !== undefined) return local
      const fresh = rng.id()
      await store.commit([{ put: 'kv', key: 'workspaceId', value: fresh }])
      return fresh
    }
    const empty = segs === 0 && pending === 0
    const ok = empty || (await o.confirmWorkspace?.({ dest: d.rt.id, local: local ?? null, remote: foreign })) === true
    if (!ok) return false
    const id = local ?? (empty ? (foreign[0] as string) : rng.id())
    await store.commit([
      { put: 'kv', key: 'workspaceId', value: id },
      { put: 'kv', key: 'workspaceAliases', value: [...new Set([...accepted, ...foreign])].sort() },
    ])
    return id
  }

  /** Every hash-matching key file the destination lists (first intact copy of each). */
  const remoteKeyFiles = async (d: Dest, listing: Listing): Promise<KeyFileBody[]> => {
    const files: KeyFileBody[] = []
    for (const k of [...listing.entries.keys()].filter(isKeyFile).sort()) {
      for (const e of listing.entries.get(k) ?? []) {
        const body = await d.cfg.remote.get(e)
        if (body && hashMatches(k, body)) {
          files.push({ key: k, body })
          break
        }
      }
    }
    return files
  }

  /**
   * Is this destination sealed? Established POSITIVELY before anything is sent: a full listing is one
   * paginated pass that may have lost the page holding `keys/`, so `keys/` gets its own listing.
   * Plaintext needs proof too: an object stored in the clear, an empty (plaintext) `ws/` marker, or a
   * destination nobody initialised yet. Anything else is unknown: nothing is sent this round.
   * Seen sealed once, sealed forever.
   */
  const establishSealedness = async (
    d: Dest,
    m: DestMeta,
    listing: Listing,
    signal?: AbortSignal,
  ): Promise<Sealedness> => {
    const keyFileListed = (l: Listing): boolean => [...l.entries.keys()].some(isKeyFile)
    if (d.cfg.sealed === true || m.sealed) return 'sealed'
    if (keyFileListed(listing)) {
      m.sealed = true
      return 'sealed'
    }
    if (m.plain) return 'plain'
    const keys = await runListing(
      d.cfg.remote,
      { full: false, calls: [{ prefix: 'keys/' }] },
      { pageSize: o.pageSize, signal },
    )
    if (keyFileListed(keys)) {
      for (const [k, es] of keys.entries) listing.entries.set(k, es)
      for (const k of keys.entries.keys()) confirm(m, k)
      m.sealed = true
      return 'sealed'
    }
    const proven = async (): Promise<void> => {
      m.plain = true
      await saveMeta(m) // before anything is sent: the decision survives a crash mid-round
    }
    const visible = [...listing.entries.keys()].filter((k) => isData(k) || parseKey(k)?.kind === 'ws').sort()
    for (const k of visible) {
      for (const e of listing.entries.get(k) ?? []) {
        abortIfNeeded(signal)
        const body = await d.cfg.remote.get(e)
        if (body === null) continue
        if (isData(k)) prefetched.set(e, body)
        const clear = parseKey(k)?.kind === 'ws' ? body.length === 0 : inClear(k, body)
        if (clear) {
          await proven()
          return 'plain'
        }
      }
    }
    if (visible.length > 0) return 'unknown'
    // Nothing readable is listed. A sealed root always holds fmt/v1 (written right after its key file):
    // without it, nobody initialised this destination — this device does, in the clear.
    if ((await d.cfg.remote.get({ key: FMT_KEY })) !== null) return 'unknown'
    await proven()
    return 'plain'
  }

  /**
   * Key envelopes are a synced set: every one this device knows must be on the destination, confirmed
   * by READING IT BACK intact (a listing shows a damaged copy just as well). One that is missing or
   * damaged is put again. Ok only when all of them — and one for every key id used here — are.
   */
  const syncEnvelopes = async (
    d: Dest,
    m: DestMeta,
    verifying: boolean,
    signal?: AbortSignal,
  ): Promise<{ up: number; ok: boolean }> => {
    const ring = d.cfg.keyring
    const files = (await ring?.files?.()) ?? []
    const read: Record<Key, true> = verifying ? {} : { ...(m.keysRead ?? {}) }
    const intact = async (f: KeyFileBody): Promise<boolean> => {
      const body = await d.cfg.remote.get({ key: f.key })
      return body !== null && hashMatches(f.key, body)
    }
    let up = 0
    for (const f of files) {
      if (read[f.key] && m.confirmed[f.key] !== undefined) continue
      abortIfNeeded(signal)
      let ok = await intact(f)
      if (!ok) {
        await d.cfg.remote.put(f.key, f.body)
        up++
        ok = await intact(f)
      }
      if (ok) {
        read[f.key] = true
        confirm(m, f.key)
      }
    }
    m.keysRead = read
    const confirmedIds = new Set<string>()
    for (const f of files) {
      const id = ring?.keyIdOf?.(f) ?? null
      if (id !== null && read[f.key]) confirmedIds.add(id)
    }
    const cur = await ring?.current()
    const needed = [...(m.usedKeys ?? []), ...(cur ? [cur.id] : [])]
    const ok = files.every((f) => read[f.key] === true) && needed.every((id) => confirmedIds.has(id))
    m.keyGap = !ok
    return { up, ok }
  }

  const download = async (
    d: Dest,
    m: DestMeta,
    sealed: boolean,
    listing: Listing,
    signal: AbortSignal | undefined,
  ): Promise<{ down: number; deferred: number; noKey: boolean }> => {
    let inv = await inventory()
    const freshDevice = inv.log.size === 0
    const rank = (k: Key): number => {
      const kind = parseKey(k)?.kind
      if (kind === 'ckpt') return freshDevice ? 0 : 1
      if (kind === 'seg') return freshDevice ? 1 : 0
      return kind === 'bman' ? 2 : 3
    }
    const missing = [...listing.entries.keys()]
      .filter((k) => isData(k) && !has(inv, k))
      .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    let down = 0
    let deferred = 0
    let noKey = false
    const take = async (key: Key, entries: Entry[]): Promise<void> => {
      abortIfNeeded(signal)
      const r = await fetchInto(d, m, sealed, key, entries)
      if (r === 'ok') down++
      else if (r !== 'absent') deferred++
      if (r === 'no-key') noKey = true
    }
    for (const key of missing) await take(key, listing.entries.get(key) ?? [])
    // Closure of files: what local segments reference must be local too. A full listing already
    // showed everything this destination has; an incremental one fetches by key.
    inv = await inventory()
    const wantedBmans = new Set<Key>()
    for (const k of inv.log) for (const id of (await headerOf(k))?.blobRefs ?? []) wantedBmans.add(bmanKey(id))
    for (const k of wantedBmans) if (!inv.bmans.has(k) && !listing.full && !listing.entries.has(k)) await take(k, [])
    inv = await inventory()
    for (const bm of inv.bmans) {
      for (const c of (await chunksOf(bm)) ?? []) {
        if (!inv.chunks.has(c) && !listing.full && !listing.entries.has(c)) await take(c, [])
      }
    }
    return { down, deferred, noKey }
  }

  /** Still to send: not confirmed, and not sent less than 10 min ago (unless verifying: it is not there). */
  const fresh = (m: DestMeta, k: Key, verifying: boolean): boolean => {
    if (m.confirmed[k] !== undefined) return false
    const at = m.awaiting[k]
    return verifying || at === undefined || clock.now() - at >= awaitingMs
  }

  const putAll = async (d: Dest, m: DestMeta, sealed: boolean, keys: Key[], signal?: AbortSignal): Promise<number> => {
    let up = 0
    for (const k of keys) {
      abortIfNeeded(signal)
      const plain = k === FMT_KEY ? FMT_V1 : parseKey(k)?.kind === 'ws' ? new Uint8Array() : await plainOf(k)
      if (!plain) continue
      await putPlain(d, sealed, k, plain)
      m.awaiting[k] = clock.now()
      up++
    }
    return up
  }

  const confirmAwaiting = async (d: Dest, m: DestMeta, keys: Key[], signal?: AbortSignal): Promise<void> => {
    if (keys.length === 0) return
    const seen = await confirmByListing(d.cfg.remote, keys, { pageSize: o.pageSize, signal })
    for (const k of seen) confirm(m, k)
  }

  /** Is everything a log object references confirmed on this destination? Unknown refs: never. */
  const closed = async (m: DestMeta, key: Key): Promise<boolean> => {
    const h = await headerOf(key)
    if (!h) return false
    for (const id of h.blobRefs) {
      const bm = bmanKey(id)
      if (m.confirmed[bm] === undefined) return false
      for (const c of (await chunksOf(bm)) ?? []) if (m.confirmed[c] === undefined) return false
    }
    return true
  }

  /**
   * Plaintext markers are what proves "plaintext" to devices that were not told: a damaged one (an
   * empty ws/ marker that is not empty, a wrong fmt/v1) is put again until it reads back intact.
   */
  const repairMarkers = async (d: Dest, m: DestMeta, ws: string, signal?: AbortSignal): Promise<number> => {
    let up = 0
    let intact = 0
    const markers: [Key, Uint8Array][] = [
      [FMT_KEY, FMT_V1],
      [`ws/${ws}`, new Uint8Array()],
    ]
    for (const [k, plain] of markers) {
      if (m.confirmed[k] === undefined) continue
      abortIfNeeded(signal)
      const body = await d.cfg.remote.get({ key: k })
      if (body === null) continue
      if (body.length === plain.length && body.every((b, i) => b === plain[i])) intact++
      else {
        await d.cfg.remote.put(k, plain)
        up++
      }
    }
    if (intact === markers.length) m.markersOk = true
    return up
  }

  /** Uploads what is missing: markers, chunks → manifests → segments, each layer confirmed first. */
  const upload = async (
    d: Dest,
    m: DestMeta,
    sealed: boolean,
    ws: string,
    signal: AbortSignal | undefined,
    verifying: boolean,
  ): Promise<{ up: number; deferred: number }> => {
    const want = (k: Key): boolean => fresh(m, k, verifying)
    let up = 0
    if (sealed) {
      // Envelopes first, confirmed: without them no other device could ever open what follows.
      const env = await syncEnvelopes(d, m, verifying, signal)
      up += env.up
      const blocked = async (): Promise<{ up: number; deferred: number }> => {
        const inv0 = await inventory()
        return { up, deferred: [...inv0.log, ...inv0.chunks, ...inv0.bmans].filter(want).length }
      }
      if (!env.ok) return blocked()
      // Then fmt/v1, confirmed: a sealed root with data always shows it (that is what makes an
      // unlisted keys/ page detectable by devices that were not told it is sealed).
      const markers = [FMT_KEY, `ws/${ws}`].filter((k) => (k === FMT_KEY ? m.confirmed[k] === undefined : want(k)))
      up += await putAll(d, m, sealed, markers, signal)
      await confirmAwaiting(d, m, markers, signal)
      if (m.confirmed[FMT_KEY] === undefined) return blocked()
      const cur = await d.cfg.keyring?.current()
      if (cur && !(m.usedKeys ?? []).includes(cur.id)) m.usedKeys = [...(m.usedKeys ?? []), cur.id].sort()
    } else {
      up += await putAll(d, m, sealed, [FMT_KEY, `ws/${ws}`].filter(want), signal)
      if (!m.markersOk) up += await repairMarkers(d, m, ws, signal)
    }
    let inv = await inventory()
    const logKeys = [...inv.log].filter(want).sort()
    // Files a segment needs but this device lacks: fetch them from another destination first.
    for (const k of logKeys) {
      for (const id of (await headerOf(k))?.blobRefs ?? []) {
        const bm = bmanKey(id)
        if (!inv.bmans.has(bm)) await fetchElsewhere(d.rt.id, bm)
      }
    }
    inv = await inventory()
    for (const bm of inv.bmans) {
      for (const c of (await chunksOf(bm)) ?? []) if (!inv.chunks.has(c)) await fetchElsewhere(d.rt.id, c)
    }
    inv = await inventory()
    const chunks = [...inv.chunks].filter(want).sort()
    up += await putAll(d, m, sealed, chunks, signal)
    await confirmAwaiting(
      d,
      m,
      Object.keys(m.awaiting).filter((k) => parseKey(k)?.kind === 'blob'),
      signal,
    )
    let deferred = 0
    const bmans: Key[] = []
    for (const bm of [...inv.bmans].filter(want).sort()) {
      const cs = await chunksOf(bm)
      if (cs?.every((c) => m.confirmed[c] !== undefined)) bmans.push(bm)
      else deferred++
    }
    up += await putAll(d, m, sealed, bmans, signal)
    await confirmAwaiting(
      d,
      m,
      Object.keys(m.awaiting).filter((k) => parseKey(k)?.kind === 'bman'),
      signal,
    )
    const segs: Key[] = []
    for (const k of logKeys) {
      if (await closed(m, k)) segs.push(k)
      else deferred++
    }
    up += await putAll(d, m, sealed, segs, signal)
    await confirmAwaiting(d, m, Object.keys(m.awaiting), signal)
    return { up, deferred }
  }

  interface RoundOptions {
    full: boolean
    readOnly: boolean
    signal?: AbortSignal
    verifying?: boolean
  }

  /** One round on a destination; the caller holds its lock. Returns the listing for verify. */
  const roundBody = async (
    d: Dest,
    m: DestMeta,
    ro: RoundOptions,
  ): Promise<RoundResult & { listing: Listing | null; sealedness?: Sealedness }> => {
    const id = d.rt.id
    if (d.cfg.paused) {
      d.rt.state = 'paused'
      return { ...ZERO, listing: null }
    }
    if (!ro.readOnly && (o.checkpointEvery ?? CHECKPOINT_EVERY) > 0) {
      await buildCheckpoint({ store, log, clock, codec, deviceId: await log.deviceId(), every: o.checkpointEvery })
    }
    const now = clock.now()
    const full = ro.full || m.lastFullAt === undefined || now - m.lastFullAt >= FULL_LISTING_EVERY_MS
    const plan = planListing({
      full,
      mode: d.cfg.incremental ?? 'start-after',
      known: Object.keys(m.confirmed),
      lastListedAt: m.lastListedAt,
    })
    const listing = await runListing(d.cfg.remote, plan, { pageSize: o.pageSize, signal: ro.signal })
    if (listing.full) {
      m.lastFullAt = now
      fullDone.add(id)
    }
    m.lastListedAt = now
    // A full listing is the truth: a key confirmed earlier but absent now (lost by the provider, or a
    // page omitted) is no longer counted as protected there, and will be sent again.
    if (listing.full) {
      for (const k of Object.keys(m.confirmed)) {
        if (listing.entries.has(k)) continue
        delete m.confirmed[k]
        delete m.keysRead?.[k]
      }
    }
    for (const k of listing.entries.keys()) confirm(m, k)
    const sealedness = await establishSealedness(d, m, listing, ro.signal)
    if (sealedness === 'unknown') {
      d.rt.state = 'ok'
      d.rt.reason = 'seal-unknown'
      const inv0 = await inventory()
      return {
        ...ZERO,
        deferred: [...inv0.log, ...inv0.chunks, ...inv0.bmans].filter((k) => m.confirmed[k] === undefined).length,
        listing,
        sealedness,
      }
    }
    if (d.rt.reason === 'seal-unknown') delete d.rt.reason
    const sealed = sealedness === 'sealed'

    if (sealed) {
      const keyring = d.cfg.keyring
      if (!o.sealer || !keyring) {
        d.rt.state = 'needs-passphrase'
        return { ...ZERO, listing }
      }
      if ((await keyring.current()) === null && keyring.learn) await keyring.learn(await remoteKeyFiles(d, listing))
      if ((await keyring.current()) === null) {
        d.rt.state = 'needs-passphrase'
        return { ...ZERO, listing }
      }
    }

    const remoteWs: string[] = []
    for (const k of listing.entries.keys()) {
      const p = parseKey(k)
      if (p?.kind === 'ws') remoteWs.push(p.workspaceId)
    }
    const ws = await workspaceGuard(d, remoteWs, ro.readOnly)
    if (ws === false) {
      d.rt.state = 'paused'
      d.rt.reason = 'workspace'
      return { ...ZERO, listing }
    }
    if (d.rt.reason === 'workspace') delete d.rt.reason

    const dl = await download(d, m, sealed, listing, ro.signal)
    let up = 0
    let deferred = dl.deferred
    if (!ro.readOnly && !dl.noKey && ws !== null) {
      const ul = await upload(d, m, sealed, ws, ro.signal, ro.verifying === true)
      up = ul.up
      deferred += ul.deferred
    }
    const inv = await inventory()
    // A key that could not be downloaded here but is local now (fetched elsewhere) is no longer a problem.
    for (const k of Object.keys(m.failures)) if (has(inv, k)) delete m.failures[k]
    d.rt.incoming = [...listing.entries.keys()].filter((k) => isData(k) && !has(inv, k)).length
    d.rt.corrupt = Object.values(m.failures).filter((n) => n >= maxFailures).length
    d.rt.state = dl.noKey ? 'needs-passphrase' : 'ok'
    if (d.rt.corrupt > 0) d.rt.reason = 'corrupt'
    else if (d.rt.reason === 'corrupt') delete d.rt.reason
    return { down: dl.down, up, deferred, listing, sealedness }
  }

  /** Runs `fn` around status bookkeeping: errors are recorded on the destination, then rethrown. */
  const tracked = async <T>(d: Dest, m: DestMeta, fn: () => Promise<T>): Promise<T> => {
    d.rt.state = 'syncing'
    emit()
    try {
      const out = await fn()
      if (stateOf(d) === 'ok') {
        m.lastOkAt = clock.now()
        d.rt.lastOkAt = m.lastOkAt
        delete d.rt.error
      }
      return out
    } catch (e) {
      if (e instanceof RemoteError) {
        d.rt.state = STATE_FOR[e.kind]
        d.rt.error = { kind: e.kind, message: e.message, at: clock.now() }
      } else if (!(e instanceof DOMException && e.name === 'AbortError')) {
        d.rt.state = 'error'
      } else {
        d.rt.state = 'ok'
      }
      throw e
    } finally {
      await saveMeta(m)
      await refresh()
    }
  }

  const runRound = (d: Dest, ro: RoundOptions): Promise<RoundResult> =>
    (async () => {
      const m = await loadMeta(d.rt.id)
      const r = await tracked(d, m, () => roundBody(d, m, ro))
      return { down: r.down, up: r.up, deferred: r.deferred }
    })()

  const refresh = async (): Promise<EngineStatus> => {
    const inv = await inventory()
    const local = new Set<Key>([...inv.log, ...inv.chunks, ...inv.bmans])
    const [pending, seen0, upgrades] = await store.read(['pending', 'kv', 'segments'], async (tx) => {
      const keys = [...inv.log].filter((k) => !headers.has(k))
      const rows = await Promise.all(keys.map((k) => tx.get<SegmentRow>('segments', k)))
      let upgrades = 0
      for (const r of rows) {
        if (r?.state === 'applied') headers.set(r.key, r.header)
        else if (r) upgrades++
      }
      return Promise.all([tx.count('pending'), tx.get<Record<Key, number>>('kv', 'sync:seen'), upgrades])
    })
    const seen = { ...(seen0 ?? {}) }
    let changed = false
    const now = clock.now()
    for (const k of local) {
      if (seen[k] === undefined) {
        seen[k] = now
        changed = true
      }
    }
    if (changed) await store.commit([{ put: 'kv', key: 'sync:seen', value: seen }])
    const entries: { runtime: DestRuntime; confirmed: Set<Key> }[] = []
    for (const d of dests.values()) {
      const m = await loadMeta(d.rt.id)
      d.rt.lastVerifiedAt = m.lastVerifiedAt
      if (m.lastOkAt !== undefined) d.rt.lastOkAt = m.lastOkAt
      // Sealed objects whose envelope is not confirmed there open for nobody else: not protected there.
      const keys = Object.keys(m.confirmed).filter((k) => !(m.keyGap === true && isSealed(d, m) && isData(k)))
      entries.push({ runtime: d.rt, confirmed: new Set(keys) })
    }
    cached = computeStatus({
      now,
      dests: entries,
      local,
      seen,
      unsealed: pending,
      needsUpgrade: upgrades,
      unsaved: o.unsaved?.() ?? 0,
    })
    emit()
    return cached
  }

  const lockedOrThrow = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const out = await locks.run(syncLockName(id), async () => ({ v: await fn() }))
    if (out === null) throw new Error(`Lock ${syncLockName(id)} unavailable`)
    return out.v
  }

  const engine: SyncEngineImpl = {
    async round(id, signal) {
      const d = dest(id)
      const out = await locks.run(
        syncLockName(id),
        () => runRound(d, { full: !fullDone.has(id), readOnly: false, signal }),
        { ifAvailable: true },
      )
      return out ?? { ...ZERO }
    },

    verify(id, onProgress) {
      const d = dest(id)
      return lockedOrThrow(id, async () => {
        const m = await loadMeta(id)
        return tracked(d, m, async () => {
          const r = await roundBody(d, m, { full: true, readOnly: false, verifying: true })
          const listing = r.listing
          // Nothing is judged (let alone "repaired" in the clear) where sealedness is not established.
          if (!listing || d.rt.state !== 'ok' || r.sealedness === 'unknown') {
            return { missing: r.up, corrupt: 0, repaired: r.up }
          }
          const sealed = isSealed(d, m)
          const keys = [...listing.entries.keys()].filter(isData).sort()
          const toRepair = new Set<Key>()
          let noKey = false
          const pass = await verifyPass({
            keys,
            cursor: m.verifyCursor,
            onProgress,
            saveCursor: async (k) => {
              if (k === undefined) delete m.verifyCursor
              else m.verifyCursor = k
              await saveMeta(m)
            },
            check: async (key) => {
              for (const e of listing.entries.get(key) ?? []) {
                const body = await d.cfg.remote.get(e)
                if (body === null) continue
                let plain: Uint8Array
                try {
                  plain = await openBody(d, sealed, key, body)
                } catch (err) {
                  if (err instanceof ObjectIntegrityError) continue // this copy does not open: try the next
                  if (!(err instanceof KeyUnavailableError)) throw err
                  noKey = true // sealed with a key this device has not unlocked: cannot judge it
                  return 'ok'
                }
                if (hashMatches(key, plain)) return 'ok'
              }
              const inv = await inventory()
              if (has(inv, key) || (await fetchElsewhere(id, key))) {
                const plain = await plainOf(key)
                if (plain) {
                  await putPlain(d, sealed, key, plain)
                  m.awaiting[key] = clock.now()
                  toRepair.add(key)
                  return 'repaired'
                }
              }
              return 'corrupt'
            },
          })
          await confirmAwaiting(d, m, [...toRepair])
          if (noKey) d.rt.state = 'needs-passphrase'
          else m.lastVerifiedAt = clock.now()
          return { missing: r.up, corrupt: pass.corrupt, repaired: r.up + pass.repaired }
        })
      })
    },

    async restoreDrill(id) {
      const d = dest(id)
      const tmp = memoryStore()
      const tmpLog = createLocalLog({ store: tmp, locks: memoryLocks(), clock, rng, codec })
      const tmpBlobs = blobStore(tmp)
      const drill = build({
        store: tmp,
        log: tmpLog,
        blobs: tmpBlobs,
        locks: memoryLocks(),
        clock,
        rng,
        codec,
        sealer: o.sealer,
        pageSize: o.pageSize,
        checkpointEvery: 0,
      })
      // Opened as a stranger would: sealedness from what this device learned, and keys ONLY through the
      // envelopes the destination itself holds (never the device's cached keyring as such).
      const meta = await loadMeta(id)
      const sealed = d.cfg.sealed === true || meta.sealed
      let keyring = d.cfg.keyring
      if (keyring) {
        const listing = await runListing(
          d.cfg.remote,
          { full: false, calls: [{ prefix: 'keys/' }] },
          { pageSize: o.pageSize },
        )
        keyring = scopedKeyring(keyring, await remoteKeyFiles(d, listing))
      }
      drill.engine.addDest({ ...d.cfg, keyring, sealed, paused: false })
      const state = await drill.drillRound(id)
      if (state !== 'ok') return { equal: false, diff: [`destination: ${state}`] }
      const [mine, theirs] = await Promise.all([persistedDoc(store, codec), persistedDoc(tmp, codec)])
      const diff = diffCanonical(canonicalState(mine), canonicalState(theirs))
      const refs = new Set<string>()
      for (const r of await tmpLog.since(0)) for (const ref of r.rec.header.blobRefs) refs.add(ref)
      for (const ref of [...refs].sort()) {
        if ((await blobs.get(ref)) !== null && (await tmpBlobs.get(ref)) === null) diff.push(`blob ${ref}: missing`)
      }
      mine.destroy()
      theirs.destroy()
      return { equal: diff.length === 0, diff }
    },

    status: () => cached,
    subscribe(fn) {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },

    addDest(cfg) {
      const id = cfg.id ?? cfg.remote.id
      if (dests.has(id)) throw new RangeError(`Destination ${id} already added`)
      dests.set(id, {
        cfg,
        rt: { id, label: cfg.label ?? id, state: cfg.paused ? 'paused' : 'ok', incoming: 0, corrupt: 0 },
      })
      return id
    },
    removeDest(id) {
      dests.delete(id)
      fullDone.delete(id)
    },
    setPaused(id, paused) {
      const d = dest(id)
      d.cfg = { ...d.cfg, paused }
      d.rt.state = paused ? 'paused' : 'ok'
      emit()
    },
    destIds: () => [...dests.keys()],
    noteSchedule(id, nextTryAt) {
      const d = dests.get(id)
      if (!d) return
      if (nextTryAt === undefined) delete d.rt.nextTryAt
      else {
        d.rt.nextTryAt = nextTryAt
        if (d.rt.state === 'ok' || d.rt.state === 'syncing') d.rt.state = 'backoff'
      }
      cached = {
        ...cached,
        dests: cached.dests.map((s) => {
          if (s.id !== id) return s
          const { nextTryAt: _old, ...rest } = s
          return nextTryAt === undefined ? { ...rest, state: d.rt.state } : { ...rest, state: d.rt.state, nextTryAt }
        }),
      }
      emit()
    },
    refresh,
    async checkpoint() {
      const rec = await buildCheckpoint({ store, log, clock, codec, deviceId: await log.deviceId(), every: 1 })
      return rec?.key ?? null
    },
    async workspaceId() {
      return (await store.read(['kv'], (tx) => tx.get<string>('kv', 'workspaceId'))) ?? null
    },
  }

  /** Read-only full round used by restoreDrill on a throwaway store. */
  const drillRound = async (id: string): Promise<DestState> => {
    const d = dest(id)
    await roundBody(d, await loadMeta(id), { full: true, readOnly: true })
    return d.rt.state
  }
  return { engine, drillRound }
}
