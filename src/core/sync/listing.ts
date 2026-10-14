import type { Entry, Key, RemoteStore } from '../contracts/remote'
import { parseKey } from '../log/codec'

/** How a provider lists only what is new; the engine falls back to a full listing regularly anyway. */
export type IncrementalMode = 'start-after' | 'created-after' | 'none'

export const FULL_LISTING_EVERY_MS = 30 * 60 * 1000
/** created-after listings look back this far, to absorb clock skew and delayed visibility. */
export const CREATED_AFTER_MARGIN_MS = 15 * 60 * 1000

export interface ListCall {
  prefix: string
  startAfter?: Key
  createdAfter?: number
  /** Stop reading as soon as a key reaches this one (listings are in key order). */
  until?: Key
}
export interface ListPlan {
  full: boolean
  calls: ListCall[]
}

export interface Listing {
  full: boolean
  /** Only names the strict parser accepts; mangled copies ("x 2.seg") and foreign files are ignored. */
  entries: Map<Key, Entry[]>
  ignored: number
}

const pad = (n: number): string => String(n).padStart(10, '0')

/** Per device: the highest seq such that every seq from 0 up to it has been seen (-1: seq 0 not seen yet). */
export function watermarks(keys: Iterable<Key>): Map<string, number> {
  const seqs = new Map<string, Set<number>>()
  for (const k of keys) {
    const p = parseKey(k)
    if (p?.kind !== 'seg') continue
    const s = seqs.get(p.deviceId) ?? new Set<number>()
    s.add(p.seq)
    seqs.set(p.deviceId, s)
  }
  const out = new Map<string, number>()
  for (const [dev, s] of seqs) {
    let wm = -1
    while (s.has(wm + 1)) wm++
    out.set(dev, wm)
  }
  return out
}

/**
 * What to list. Full: everything. Incremental (start-after, S3 style): each known device from its
 * contiguous watermark; unknown devices in every gap between known ids (each gap read only until the
 * next known device, so it costs one short page); and the small prefixes (`keys/`, `ws/`, `ckpt/`) in
 * full. `keys/` and `ws/` are ALWAYS listed in full: a sealed destination or a foreign workspace must
 * never be missed. Files are fetched by key.
 */
export function planListing(o: {
  full: boolean
  mode: IncrementalMode
  known: Iterable<Key>
  lastListedAt?: number
}): ListPlan {
  if (o.full || o.mode === 'none') return { full: true, calls: [{ prefix: '' }] }
  const always: ListCall[] = [{ prefix: 'keys/' }, { prefix: 'ws/' }]
  if (o.mode === 'created-after') {
    const createdAfter = o.lastListedAt === undefined ? undefined : o.lastListedAt - CREATED_AFTER_MARGIN_MS
    if (createdAfter === undefined) return { full: true, calls: [{ prefix: '' }] }
    return { full: false, calls: [...always, { prefix: '', createdAfter }] }
  }
  const wm = watermarks(o.known)
  const calls: ListCall[] = [...always, { prefix: 'ckpt/' }]
  const devices = [...wm.keys()].sort()
  for (const dev of devices) {
    const w = wm.get(dev) ?? -1
    calls.push(w < 0 ? { prefix: `seg/${dev}/` } : { prefix: `seg/${dev}/`, startAfter: `seg/${dev}/${pad(w)}` })
  }
  // '~' sorts after every character a key may contain: `seg/<dev>/~` is past all of dev's segments.
  for (let i = 0; i <= devices.length; i++) {
    const call: ListCall = { prefix: 'seg/' }
    const prev = devices[i - 1]
    const next = devices[i]
    if (prev !== undefined) call.startAfter = `seg/${prev}/~`
    if (next !== undefined) call.until = `seg/${next}/`
    calls.push(call)
  }
  return { full: false, calls }
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

/** Runs a plan; duplicates (same key, several handles) are kept, repeated identical entries are not. */
export async function runListing(
  remote: RemoteStore,
  plan: ListPlan,
  o: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<Listing> {
  const entries = new Map<Key, Entry[]>()
  let ignored = 0
  for (const call of plan.calls) {
    abortIfNeeded(o.signal)
    const lo: { startAfter?: Key; createdAfter?: number; pageSize?: number } = {}
    if (call.startAfter !== undefined) lo.startAfter = call.startAfter
    if (call.createdAfter !== undefined) lo.createdAfter = call.createdAfter
    if (o.pageSize !== undefined) lo.pageSize = o.pageSize
    for await (const e of remote.list(call.prefix, lo)) {
      if (call.until !== undefined && e.key >= call.until) break
      if (parseKey(e.key) === null) {
        ignored++
        continue
      }
      const list = entries.get(e.key) ?? []
      if (!list.some((x) => x.handle === e.handle)) list.push(e)
      entries.set(e.key, list)
    }
  }
  return { full: plan.full, entries, ignored }
}

/** Directory part of a key: `seg/dev/` for a segment, `blob/ab/` for a chunk, `fmt/` … */
export const dirOf = (key: Key): string => key.slice(0, key.lastIndexOf('/') + 1)

/**
 * Confirms keys by listing: one call per directory, starting just before the smallest key.
 * Returns the keys that were seen.
 */
export async function confirmByListing(
  remote: RemoteStore,
  keys: Iterable<Key>,
  o: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<Set<Key>> {
  const byDir = new Map<string, Key[]>()
  for (const k of keys) {
    const d = dirOf(k)
    byDir.set(d, [...(byDir.get(d) ?? []), k])
  }
  const seen = new Set<Key>()
  for (const [dir, ks] of [...byDir].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const wanted = new Set(ks)
    const min = [...ks].sort()[0] ?? dir
    const plan: ListPlan = { full: false, calls: [{ prefix: dir, startAfter: min.slice(0, -1) }] }
    const listing = await runListing(remote, plan, o)
    for (const k of listing.entries.keys()) if (wanted.has(k)) seen.add(k)
  }
  return seen
}
