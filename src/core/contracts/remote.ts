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
  list(prefix: string, o?: { startAfter?: Key; createdAfter?: number; pageSize?: number }): AsyncIterable<Entry>
  get(e: Entry): Promise<Uint8Array | null> // null seulement sur un 404 certain
  put(key: Key, body: Uint8Array): Promise<void>
} // idempotent par clé
