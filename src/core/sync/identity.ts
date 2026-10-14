import { sha256Hex } from '../log/codec'

/** What makes a destination itself: changing any of these creates a NEW destination. */
export interface DestIdentity {
  type: string
  endpoint?: string
  /** Bucket, Drive folder, Dropbox app folder, CloudKit container… */
  bucket?: string
  prefix?: string
}

const TYPE = /^[a-z0-9-]{1,32}$/

/** Leading/trailing slashes and repeated slashes do not change the location. */
export function normalizePrefix(prefix = ''): string {
  return prefix
    .split('/')
    .filter((p) => p.length > 0)
    .join('/')
}

/** Destination id = hash(type, endpoint, bucket/folder, prefix), readable type first: `s3-0123456789abcdef`. */
export function destinationId(d: DestIdentity): string {
  if (!TYPE.test(d.type)) throw new RangeError(`Invalid destination type ${d.type}`)
  const endpoint = (d.endpoint ?? '').trim().replace(/\/+$/, '').toLowerCase()
  const canonical = JSON.stringify([d.type, endpoint, d.bucket ?? '', normalizePrefix(d.prefix)])
  return `${d.type}-${sha256Hex(new TextEncoder().encode(canonical)).slice(0, 16)}`
}

/** Per-destination sync lock (taken with ifAvailable: a busy destination is skipped, never queued twice). */
export const syncLockName = (destId: string): string => `cursus:sync:${destId}`
