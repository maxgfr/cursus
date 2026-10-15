export type { RemoteErrorKind } from './errors'
export { RemoteError } from './errors'

export type Key = string
export interface Entry {
  key: Key
  size?: number
  handle?: string
} // handle = id de fichier ; doublons permis
export interface RemoteStore {
  readonly id: string
  /**
   * How this store lists only what is new (default `start-after`, S3 style). `created-after`: a server-side time
   * filter or a change cursor; `none`: every listing reads everything, so one full listing is the cheapest.
   */
  readonly incremental?: 'start-after' | 'created-after' | 'none'
  list(prefix: string, o?: { startAfter?: Key; createdAfter?: number; pageSize?: number }): AsyncIterable<Entry>
  get(e: Entry): Promise<Uint8Array | null> // null seulement sur un 404 certain
  put(key: Key, body: Uint8Array): Promise<void>
} // idempotent par clé
