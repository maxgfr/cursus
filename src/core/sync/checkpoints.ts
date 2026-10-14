import * as Y from 'yjs'
import type { EnvelopeCodec, Header, LocalLog, SegmentRec } from '../contracts/log'
import type { Clock, LocalStore } from '../contracts/ports'
import type { Key } from '../contracts/remote'
import { codec as defaultCodec, refsOf } from '../log/codec'
import type { SegmentRow } from '../log/localLog'

/** Build a checkpoint once this many applied segments are not covered by any local checkpoint. */
export const CHECKPOINT_EVERY = 256

interface SnapshotRow {
  update: Uint8Array
  through: number
}

async function rows(store: LocalStore): Promise<{ rows: SegmentRow[]; snap: SnapshotRow | undefined }> {
  const [rs, snap] = await store.read(['segments', 'snapshot'], (tx) =>
    Promise.all([tx.getAll<SegmentRow>('segments'), tx.get<SnapshotRow>('snapshot', 'main')]),
  )
  rs.sort((a, b) => a.arrival - b.arrival)
  return { rows: rs, snap }
}

/** Keys covered by the local checkpoints (union of their `covers`). */
export function coveredBy(all: readonly SegmentRow[]): Set<Key> {
  const out = new Set<Key>()
  for (const r of all)
    if (r.header.kind === 'ckpt' && r.state === 'applied') for (const k of r.header.covers ?? []) out.add(k)
  return out
}

/** Persisted state WITHOUT pending edits: snapshot + applied segments, in a fresh doc. */
export async function persistedDoc(store: LocalStore, codec: EnvelopeCodec = defaultCodec): Promise<Y.Doc> {
  const { rows: rs, snap } = await rows(store)
  const doc = new Y.Doc()
  if (snap) Y.applyUpdateV2(doc, snap.update)
  for (const r of rs) {
    if (r.arrival <= (snap?.through ?? 0) || r.state !== 'applied') continue
    Y.applyUpdateV2(doc, codec.decode(r.key, r.bytes).update)
  }
  return doc
}

export interface CheckpointOptions {
  store: LocalStore
  log: LocalLog
  clock: Clock
  deviceId: string
  codec?: EnvelopeCodec
  /** Minimum number of uncovered segments; 1 forces a checkpoint whenever anything is uncovered. */
  every?: number
}

/**
 * Builds a checkpoint in a FRESH Y.Doc from persisted segments only (never from the live doc), in
 * arrival order, stopping before the first `needs-upgrade` segment. `covers` lists exactly the
 * segments it contains. The checkpoint is ingested into the local log, so it is uploaded like a segment.
 */
export async function buildCheckpoint(o: CheckpointOptions): Promise<SegmentRec | null> {
  const codec = o.codec ?? defaultCodec
  const { rows: rs } = await rows(o.store)
  const covered = coveredBy(rs)
  const doc = new Y.Doc()
  const covers: Key[] = []
  for (const r of rs) {
    if (r.header.kind === 'ckpt') continue
    if (r.state !== 'applied') break
    Y.applyUpdateV2(doc, codec.decode(r.key, r.bytes).update)
    covers.push(r.key)
  }
  const fresh = covers.filter((k) => !covered.has(k)).length
  if (fresh === 0 || fresh < (o.every ?? CHECKPOINT_EVERY)) {
    doc.destroy()
    return null
  }
  const update = Y.encodeStateAsUpdateV2(doc)
  doc.destroy()
  const header: Header = {
    v: 1,
    kind: 'ckpt',
    deviceId: o.deviceId,
    seq: 0,
    createdAt: o.clock.now(),
    blobRefs: refsOf(update),
    covers: covers.sort(),
  }
  const { key, bytes } = codec.encode(header, update)
  const rec = await o.log.ingest(key, bytes)
  return rec === 'duplicate' ? null : rec
}
