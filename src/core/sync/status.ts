import type { Key } from '../contracts/remote'
import type { DestState, DestStatus, SyncStatus } from '../contracts/sync'

/** A local key confirmed on no destination for this long raises the red banner. */
export const ALARM_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Why a destination stopped on its own, beyond the contract's states. `seal-unknown`: whether it is
 * sealed could not be established this round, so nothing was sent.
 */
export type DestReason = 'workspace' | 'corrupt' | 'seal-unknown'

export interface EngineDestStatus extends DestStatus {
  reason?: DestReason
  /** Keys whose every remote copy failed verification N times in a row. */
  corrupt: number
}

export interface EngineStatus extends SyncStatus {
  dests: EngineDestStatus[]
  /** Red banner: some local key is confirmed nowhere for more than 24 h. */
  alarm: boolean
  /** Destinations on which every local key is confirmed. */
  protectedOn: number
  /** Captured edits the local log has not acknowledged yet (failed append, queued behind one). */
  unsaved: number
  /** Segments from another device the sync guard holds back until the user decides (always set by `computeStatus`). */
  held?: number
}

/** Runtime part of a destination status, owned by the engine and the scheduler. */
export interface DestRuntime {
  id: string
  label: string
  state: DestState
  lastOkAt?: number
  nextTryAt?: number
  lastVerifiedAt?: number
  error?: DestStatus['error']
  reason?: DestReason
  incoming: number
  corrupt: number
}

export interface StatusInput {
  now: number
  dests: { runtime: DestRuntime; confirmed: ReadonlySet<Key> }[]
  /** Every object this device holds and must protect: segments, checkpoints, chunks, manifests. */
  local: ReadonlySet<Key>
  /** When each local key was first seen by the engine. */
  seen: Readonly<Record<Key, number>>
  unsealed: number
  needsUpgrade: number
  /** Held segments (sync guard); their keys are not in `local`. */
  held?: number
  /** Captured updates not yet acknowledged by the local log (kept in memory, retried). */
  unsaved?: number
}

/**
 * The truth, never optimism: a key counts as protected only once a listing or a read-back showed it
 * on a destination. `safe` needs at least one destination, nothing left unsealed or unsaved, and every
 * local key confirmed somewhere. Unsaved edits count as unsealed too: they are not even in `pending`.
 */
export function computeStatus(i: StatusInput): EngineStatus {
  const unsaved = i.unsaved ?? 0
  let alarm = false
  let unconfirmedAnywhere = 0
  for (const k of i.local) {
    if (i.dests.some((d) => d.confirmed.has(k))) continue
    unconfirmedAnywhere++
    const since = i.seen[k] ?? i.now
    if (i.now - since > ALARM_AFTER_MS) alarm = true
  }
  let protectedOn = 0
  const dests: EngineDestStatus[] = i.dests.map(({ runtime, confirmed }) => {
    let unconfirmed = 0
    let oldest: number | undefined
    for (const k of i.local) {
      if (confirmed.has(k)) continue
      unconfirmed++
      const since = i.seen[k] ?? i.now
      oldest = oldest === undefined ? since : Math.min(oldest, since)
    }
    if (unconfirmed === 0) protectedOn++
    const s: EngineDestStatus = {
      id: runtime.id,
      label: runtime.label,
      state: runtime.state,
      unconfirmed,
      incoming: runtime.incoming,
      corrupt: runtime.corrupt,
    }
    if (oldest !== undefined) s.oldestUnconfirmedAt = oldest
    if (runtime.lastOkAt !== undefined) s.lastOkAt = runtime.lastOkAt
    if (runtime.nextTryAt !== undefined) s.nextTryAt = runtime.nextTryAt
    if (runtime.lastVerifiedAt !== undefined) s.lastVerifiedAt = runtime.lastVerifiedAt
    if (runtime.error !== undefined) s.error = runtime.error
    if (runtime.reason !== undefined) s.reason = runtime.reason
    return s
  })
  return {
    dests,
    unsealed: i.unsealed + unsaved,
    needsUpgrade: i.needsUpgrade,
    safe: i.dests.length > 0 && i.unsealed === 0 && unsaved === 0 && unconfirmedAnywhere === 0,
    alarm,
    protectedOn,
    unsaved,
    held: i.held ?? 0,
  }
}
