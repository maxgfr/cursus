import * as Y from 'yjs'
import { EnvelopeError } from '../contracts/errors'
import type { EnvelopeCodec, Header, LocalLog, SegmentRec } from '../contracts/log'
import type { Clock, LocalStore, Locks, ReadTx, Rng } from '../contracts/ports'
import type { Key } from '../contracts/remote'
import { codec as defaultCodec, refsOf } from './codec'

export const LOG_LOCK = 'cursus:log'

/** Row of the `segments` store: the record plus the exact bytes, never re-encoded. */
export interface SegmentRow extends SegmentRec {
  bytes: Uint8Array
}
interface PendingRow {
  update: Uint8Array
}
interface SnapshotRow {
  update: Uint8Array
  through: number
}

export interface LocalLogOptions {
  store: LocalStore
  locks: Locks
  clock: Clock
  rng: Rng
  codec?: EnvelopeCodec
  /** A segment under our own deviceId that we never wrote: this replica was cloned; a new id was taken. */
  onClone?: (previous: string, next: string) => void
}

export interface LocalLogImpl extends LocalLog {
  deviceId(): Promise<string>
  /** Re-tries `needs-upgrade` segments (after an app update); returns how many became applicable. */
  retryUpgrades(): Promise<number>
}

const toRec = (r: SegmentRow): SegmentRec => ({
  key: r.key,
  arrival: r.arrival,
  own: r.own,
  header: r.header,
  state: r.state,
})

function readPendingUpTo(tx: ReadTx) {
  return Promise.all([
    tx.getAllKeys('pending'),
    tx.getAll<PendingRow>('pending'),
    tx.get<number>('kv', 'seq'),
    tx.get<number>('kv', 'arrival'),
    tx.get<string>('kv', 'deviceId'),
  ])
}

export function createLocalLog(o: LocalLogOptions): LocalLogImpl {
  const { store, locks, clock, rng } = o
  const codec = o.codec ?? defaultCodec

  const underLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const out = await locks.run(LOG_LOCK, async () => ({ value: await fn() }))
    if (out === null) throw new Error(`Lock ${LOG_LOCK} unavailable`)
    return out.value
  }

  /** Must run under the log lock. */
  const ensureDevice = async (): Promise<string> => {
    const id = await store.read(['kv'], (tx) => tx.get<string>('kv', 'deviceId'))
    if (id !== undefined) return id
    const fresh = rng.id()
    await store.commit([{ put: 'kv', key: 'deviceId', value: fresh }])
    return fresh
  }

  /** Decodes the stored bytes; anything this build cannot read is `needs-upgrade`, not an error. */
  const classify = (key: Key, bytes: Uint8Array): { header: Header; update: Uint8Array } | null => {
    try {
      const d = codec.decode(key, bytes)
      Y.decodeUpdateV2(d.update)
      return d
    } catch (e) {
      if (e instanceof EnvelopeError && e.kind !== 'version') throw e
      return null
    }
  }

  const placeholder = (key: Key): Header => {
    const p = codec.parseKey(key)
    return {
      v: 1,
      kind: p?.kind === 'ckpt' ? 'ckpt' : 'seg',
      deviceId: p && (p.kind === 'seg' || p.kind === 'ckpt') ? p.deviceId : '',
      seq: p?.kind === 'seg' ? p.seq : 0,
      createdAt: 0,
      blobRefs: [],
    }
  }

  const allRows = async (): Promise<{ rows: SegmentRow[]; snap: SnapshotRow | undefined }> => {
    const [rows, snap] = await store.read(['segments', 'snapshot'], (tx) =>
      Promise.all([tx.getAll<SegmentRow>('segments'), tx.get<SnapshotRow>('snapshot', 'main')]),
    )
    rows.sort((a, b) => a.arrival - b.arrival)
    return { rows, snap }
  }

  const updateOf = (r: SegmentRow): Uint8Array => codec.decode(r.key, r.bytes).update

  return {
    deviceId: () => underLock(ensureDevice),

    async appendLocal(update) {
      await store.commit([{ add: 'pending', value: { update } satisfies PendingRow }])
    },

    seal() {
      return underLock(async () => {
        await ensureDevice()
        // (a) read only
        const [keys, entries, seq0, arrival0, deviceId] = await store.read(['pending', 'kv'], readPendingUpTo)
        const K = keys[keys.length - 1]
        if (entries.length === 0 || K === undefined || deviceId === undefined) return null
        const seq = seq0 ?? 0
        const arrival = (arrival0 ?? 0) + 1
        // (b) outside any transaction: appends landing now get a key > K and survive
        const update = Y.mergeUpdatesV2(entries.map((e) => e.update))
        const header: Header = { v: 1, kind: 'seg', deviceId, seq, createdAt: clock.now(), blobRefs: refsOf(update) }
        const { key, bytes } = codec.encode(header, update)
        const row: SegmentRow = { key, bytes, arrival, own: true, header, state: 'applied' }
        // (c) ONE transaction
        await store.commit([
          { put: 'segments', key, value: row },
          { put: 'kv', key: 'seq', value: seq + 1 },
          { put: 'kv', key: 'arrival', value: arrival },
          { deleteRange: 'pending', upTo: K },
        ])
        return toRec(row)
      })
    },

    ingest(key, plain) {
      return underLock(async () => {
        const parsed = codec.parseKey(key)
        if (!parsed || (parsed.kind !== 'seg' && parsed.kind !== 'ckpt')) throw new RangeError(`Not a log key: ${key}`)
        const [existing, arrival0] = await store.read(['segments', 'kv'], (tx) =>
          Promise.all([tx.get<SegmentRow>('segments', key), tx.get<number>('kv', 'arrival')]),
        )
        if (existing) return 'duplicate'
        const decoded = classify(key, plain)
        const me = await ensureDevice()
        const ops: Parameters<LocalStore['commit']>[0] = []
        let cloned: string | null = null
        if (parsed.kind === 'seg' && parsed.deviceId === me) {
          cloned = rng.id()
          ops.push({ put: 'kv', key: 'deviceId', value: cloned }, { put: 'kv', key: 'seq', value: 0 })
        }
        const arrival = (arrival0 ?? 0) + 1
        const row: SegmentRow = decoded
          ? { key, bytes: plain, arrival, own: false, header: decoded.header, state: 'applied' }
          : { key, bytes: plain, arrival, own: false, header: placeholder(key), state: 'needs-upgrade' }
        ops.push({ put: 'segments', key, value: row }, { put: 'kv', key: 'arrival', value: arrival })
        await store.commit(ops)
        if (cloned !== null) o.onClone?.(me, cloned)
        return toRec(row)
      })
    },

    async load() {
      // One transaction: a seal from another tab cannot move edits from pending to segments between reads.
      const [rows, snap, pending] = await store.read(['segments', 'snapshot', 'pending'], (tx) =>
        Promise.all([
          tx.getAll<SegmentRow>('segments'),
          tx.get<SnapshotRow>('snapshot', 'main'),
          tx.getAll<PendingRow>('pending'),
        ]),
      )
      rows.sort((a, b) => a.arrival - b.arrival)
      const updates: Uint8Array[] = []
      if (snap) updates.push(snap.update)
      let through = snap?.through ?? 0
      for (const r of rows) {
        through = Math.max(through, r.arrival)
        if (r.arrival > (snap?.through ?? 0) && r.state === 'applied') updates.push(updateOf(r))
      }
      for (const p of pending) updates.push(p.update)
      return { updates, through }
    },

    async since(arrival) {
      const { rows } = await allRows()
      return rows
        .filter((r) => r.arrival > arrival && r.state === 'applied')
        .map((r) => ({ rec: toRec(r), update: updateOf(r) }))
    },

    async bytes(key) {
      const row = await store.read(['segments'], (tx) => tx.get<SegmentRow>('segments', key))
      return row?.bytes ?? null
    },

    async keys() {
      const keys = await store.read(['segments'], (tx) => tx.getAllKeys('segments'))
      return new Set(keys.filter((k): k is string => typeof k === 'string'))
    },

    /** Snapshot rebuilt in a fresh Y.Doc from persisted data only; coverage stops before needs-upgrade. */
    compact() {
      return underLock(async () => {
        const { rows, snap } = await allRows()
        const from = snap?.through ?? 0
        const doc = new Y.Doc()
        if (snap) Y.applyUpdateV2(doc, snap.update)
        let through = from
        for (const r of rows) {
          if (r.arrival <= from) continue
          if (r.state !== 'applied') break
          Y.applyUpdateV2(doc, updateOf(r))
          through = r.arrival
        }
        if (snap && through === from) return
        const value: SnapshotRow = { update: Y.encodeStateAsUpdateV2(doc), through }
        doc.destroy()
        await store.commit([{ put: 'snapshot', key: 'main', value }])
      })
    },

    retryUpgrades() {
      return underLock(async () => {
        const { rows } = await allRows()
        const ops: Parameters<LocalStore['commit']>[0] = []
        for (const r of rows) {
          if (r.state !== 'needs-upgrade') continue
          const d = classify(r.key, r.bytes)
          if (d) ops.push({ put: 'segments', key: r.key, value: { ...r, header: d.header, state: 'applied' } })
        }
        await store.commit(ops)
        return ops.length
      })
    },
  }
}
