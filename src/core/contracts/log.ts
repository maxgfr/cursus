import type { Key } from './remote'

export interface Header {
  v: 1
  kind: 'seg' | 'ckpt'
  deviceId: string
  seq: number
  createdAt: number
  blobRefs: string[]
  covers?: Key[]
}
export type ParsedKey =
  | { kind: 'fmt' }
  | { kind: 'ws'; workspaceId: string }
  | { kind: 'keys'; hash: string }
  | { kind: 'seg'; deviceId: string; seq: number; h16: string }
  | { kind: 'ckpt'; deviceId: string; h16: string }
  | { kind: 'blob'; h64: string }
  | { kind: 'bman'; h64: string }
export interface EnvelopeCodec {
  encode(h: Header, yUpdateV2: Uint8Array): { key: Key; bytes: Uint8Array }
  decode(key: Key, bytes: Uint8Array): { header: Header; update: Uint8Array } // EnvelopeError 'hash'|'magic'|'version'
  /** `decode`, inflating off the JS thread where the platform can (same checks, same errors). */
  decodeAsync?(key: Key, bytes: Uint8Array): Promise<{ header: Header; update: Uint8Array }>
  parseKey(name: string): ParsedKey | null
} // strict : null pour « x 2.seg »
export interface SegmentRec {
  key: Key
  arrival: number
  own: boolean
  header: Header
  state: 'applied' | 'needs-upgrade'
}
export interface LocalLog {
  appendLocal(update: Uint8Array): Promise<void>
  seal(): Promise<SegmentRec | null>
  ingest(key: Key, plain: Uint8Array): Promise<SegmentRec | 'duplicate'> // vérifie + stocke, n'applique jamais
  load(): Promise<{ updates: Uint8Array[]; through: number }>
  since(arrival: number): Promise<{ rec: SegmentRec; update: Uint8Array }[]>
  bytes(key: Key): Promise<Uint8Array | null>
  keys(): Promise<ReadonlySet<Key>>
  compact(): Promise<void>
}
export interface BlobStore {
  put(data: Uint8Array, mime: string): Promise<string>
  get(id: string): Promise<Blob | null>
  objectKeys(id: string): Promise<Key[]>
  read(key: Key): Promise<Uint8Array | null>
  ingest(key: Key, body: Uint8Array): Promise<void>
}
export interface Keyring {
  current(): Promise<{ id: string; key: CryptoKey } | null>
  byId(id: string): Promise<CryptoKey | null>
}
export interface Sealer {
  seal(k: Keyring, key: Key, plain: Uint8Array): Promise<Uint8Array>
  open(k: Keyring, key: Key, body: Uint8Array): Promise<Uint8Array>
}
