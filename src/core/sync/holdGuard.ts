import * as Y from 'yjs'
import { GUARDED_KINDS, isEmptied, isLive, TEXT_MIN_CHARS, track } from '../model/deletions'
import { ROOT } from '../model/schema'

/**
 * The sync guard: segments from another device that would delete much of the library here are held back (state
 * `held` in the local log) until the user decides. What counts is cumulative over a sliding window, per writing
 * device and across all remote devices together, measured on this device's clock when each segment arrives (a
 * segment's own `createdAt` is not trusted).
 */

/** Length of the sliding window over which a device's deletions add up. */
export const HOLD_WINDOW_MS = 24 * 60 * 60 * 1000
/** Holds once a device, or all remote devices together, deleted this many entities (plus emptied texts) within the window… */
export const HOLD_AT_COUNT = 20
/** …or at least this share of the library's live entities… */
export const HOLD_AT_SHARE = 0.5
/** …when the library holds at least this many live entities. */
export const HOLD_SHARE_MIN_LIBRARY = 5
/** `kv` key of the guard's book: per writing device, its recent deletions and whether it is held (the aggregate is their union). */
export const HOLD_KV = 'sync:hold'

/** One segment's deletions, as recorded in the book. */
export interface HoldEvent {
  /** When it arrived here. */
  at: number
  /** `kind/id` of the entities it deleted (trashed, purged or removed while live). */
  deleted: string[]
  /** Texts of at least `TEXT_MIN_CHARS` it shortened first in the window: their length before. */
  shrunk: Record<string, number>
  /** Texts it emptied, against their length before the window's first shortening. */
  emptied: string[]
}

export interface DeviceHold {
  events: HoldEvent[]
  /** Everything from this device is held until the user decides. */
  holding?: true
}

export type HoldBook = Record<string, DeviceHold>

/** What one update does to the library it is applied to. */
export interface Effect {
  deleted: string[]
  texts: { key: string; before: number; after: number }[]
  /** Live entities just before it. */
  liveBefore: number
}

/** Is this many deletions, within the window, enough to hold? `library`: live entities when the window opened. */
function over(count: number, library: number): boolean {
  return count >= HOLD_AT_COUNT || (library >= HOLD_SHARE_MIN_LIBRARY && count >= library * HOLD_AT_SHARE)
}

/** Distinct entities deleted and texts emptied over these events. */
function tally(events: readonly HoldEvent[]): { deleted: Set<string>; count: number } {
  const deleted = new Set(events.flatMap((ev) => ev.deleted))
  return { deleted, count: deleted.size + new Set(events.flatMap((ev) => ev.emptied)).size }
}

const contributes = (ev: HoldEvent): boolean => ev.deleted.length > 0 || ev.emptied.length > 0

/**
 * Pure decision for one segment of `device`: hold it or not, and the next book (null: nothing to write). Two totals
 * count, with the same thresholds: the device's own deletions within the window, and those of every remote device
 * together (so a deletion split across many device ids is caught too). When the device's own total crosses, that
 * device is held; when the aggregate crosses, every device that deleted something within the window is held, the
 * sender included. A device already held stays held; a device that deletes nothing is never held by it.
 */
export function judge(
  book: HoldBook,
  device: string,
  e: Effect,
  now: number,
): { hold: boolean; next: HoldBook | null } {
  if (book[device]?.holding) return { hold: true, next: null }
  const recent = (d: DeviceHold | undefined): HoldEvent[] =>
    (d?.events ?? []).filter((ev) => ev.at > now - HOLD_WINDOW_MS)
  const events = recent(book[device])
  const baseline = (key: string): number | undefined => events.find((ev) => ev.shrunk[key] !== undefined)?.shrunk[key]
  const shrunk: Record<string, number> = {}
  const emptied: string[] = []
  for (const t of e.texts) {
    if (t.after >= t.before) continue
    const known = baseline(t.key)
    const base = known ?? t.before
    if (base < TEXT_MIN_CHARS) continue
    if (known === undefined) shrunk[t.key] = t.before
    if (isEmptied(base, t.after)) emptied.push(t.key)
  }
  if (e.deleted.length === 0 && emptied.length === 0 && Object.keys(shrunk).length === 0) {
    return { hold: false, next: null }
  }
  const ev: HoldEvent = { at: now, deleted: e.deleted, shrunk, emptied }
  // The library as it stood when the window opened: live now, plus what was deleted since (live then).
  const own = tally([...events, ev])
  const ownHold = over(own.count, e.liveBefore + tally(events).deleted.size)
  const next: HoldBook = {}
  for (const [id, d] of Object.entries(book)) {
    const kept = recent(d)
    if (kept.length > 0 || d.holding) next[id] = d.holding ? { events: kept, holding: true } : { events: kept }
  }
  next[device] = ownHold ? { events: [...events, ev], holding: true } : { events: [...events, ev] }
  const earlier = Object.entries(next).flatMap(([id, d]) => (id === device ? events : d.events))
  const aggregateHold = over(tally([...earlier, ev]).count, e.liveBefore + tally(earlier).deleted.size)
  if (aggregateHold) {
    for (const [id, d] of Object.entries(next)) if (d.events.some(contributes)) next[id] = { ...d, holding: true }
  }
  return { hold: ownHold || aggregateHold, next }
}

/**
 * A scratch copy of the library that incoming updates are tried on, to see what each would delete. It keeps,
 * per guarded entity, whether it is live and, per text, its length, updated after every update.
 */
export class Shadow {
  private readonly doc = new Y.Doc()
  private readonly live = new Map<string, boolean>()
  private readonly lengths = new Map<string, number>()
  private liveCount = 0
  /** Nothing to lose when it was made (a device syncing for the first time): it judges nothing. */
  readonly empty: boolean

  constructor(base: Y.Doc) {
    Y.applyUpdateV2(this.doc, Y.encodeStateAsUpdateV2(base))
    for (const kind of GUARDED_KINDS) {
      for (const [id, m] of this.doc.getMap(ROOT[kind])) this.setLive(`${kind}/${id}`, isLive(m))
    }
    for (const [key, t] of this.doc.getMap(ROOT.texts)) this.lengths.set(key, t instanceof Y.Text ? t.length : 0)
    this.empty = this.liveCount === 0 && this.lengths.size === 0
  }

  private setLive(ref: string, now: boolean): void {
    const was = this.live.get(ref) ?? false
    this.live.set(ref, now)
    this.liveCount += (now ? 1 : 0) - (was ? 1 : 0)
  }

  /** Applies `update` to the copy and says what it deleted there. */
  effectOf(update: Uint8Array): Effect {
    const liveBefore = this.liveCount
    const touched = track(this.doc, () => Y.applyUpdateV2(this.doc, update))
    const deleted: string[] = []
    for (const [ref, { kind, id }] of touched.entities) {
      const was = this.live.get(ref) ?? false
      const now = isLive(this.doc.getMap(ROOT[kind]).get(id))
      if (was && !now) deleted.push(ref)
      this.setLive(ref, now)
    }
    const texts: Effect['texts'] = []
    for (const key of touched.texts) {
      const t = this.doc.getMap(ROOT.texts).get(key)
      const after = t instanceof Y.Text ? t.length : 0
      const before = this.lengths.get(key) ?? 0
      if (before !== after) texts.push({ key, before, after })
      this.lengths.set(key, after)
    }
    return { deleted: deleted.sort(), texts, liveBefore }
  }

  destroy(): void {
    this.doc.destroy()
  }
}
