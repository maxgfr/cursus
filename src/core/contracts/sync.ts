import type { RemoteErrorKind } from './errors'

export type DestState =
  | 'ok'
  | 'syncing'
  | 'backoff'
  | 'needs-auth'
  | 'needs-passphrase'
  | 'needs-permission'
  | 'error'
  | 'paused'
export interface DestStatus {
  id: string
  label: string
  state: DestState
  lastOkAt?: number
  nextTryAt?: number
  lastVerifiedAt?: number
  error?: { kind: RemoteErrorKind; message: string; at: number }
  unconfirmed: number
  oldestUnconfirmedAt?: number
  incoming: number
}
export interface SyncStatus {
  dests: DestStatus[]
  unsealed: number
  needsUpgrade: number
  safe: boolean
}
export interface SyncEngine {
  round(dest: string, signal?: AbortSignal): Promise<{ down: number; up: number; deferred: number }>
  verify(
    dest: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ missing: number; corrupt: number; repaired: number }>
  restoreDrill(dest: string): Promise<{ equal: boolean; diff: string[] }>
  status(): SyncStatus
  subscribe(fn: (s: SyncStatus) => void): () => void
}
export interface Scheduler {
  start(): void
  stop(): void
  trigger(r: 'startup' | 'sealed' | 'online' | 'visible' | 'timer' | 'manual'): void
}
