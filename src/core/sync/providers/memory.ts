import type { Clock } from '../../contracts/ports'
import type { Entry, Key, RemoteStore } from '../../contracts/remote'
import { destinationId } from '../identity'

interface Version {
  handle: string
  bytes: Uint8Array
  created: number
}

/**
 * A shared in-memory "server": several devices (several MemoryRemote instances) see the same objects.
 * Objects are stored per full key (prefix included). A key may hold several versions (Drive-like
 * duplicates); `put` on an existing key replaces the primary version (S3-like overwrite).
 */
export class MemoryBucket {
  private readonly objects = new Map<string, Version[]>()
  private nextHandle = 1

  constructor(private readonly clock: Clock = { now: () => 0 }) {}

  now(): number {
    return this.clock.now()
  }

  /** Fixed-width handles sort in creation order. */
  private handle(): string {
    return `h${String(this.nextHandle++).padStart(10, '0')}`
  }

  write(fullKey: string, bytes: Uint8Array): void {
    const versions = this.objects.get(fullKey)
    const copy = bytes.slice()
    if (versions?.[0]) versions[0] = { ...versions[0], bytes: copy }
    else this.objects.set(fullKey, [{ handle: this.handle(), bytes: copy, created: this.clock.now() }])
  }

  /** Adds another object under the same name (what Drive does on concurrent creation). */
  duplicate(fullKey: string, bytes: Uint8Array): string {
    const handle = this.handle()
    const versions = this.objects.get(fullKey) ?? []
    versions.push({ handle, bytes: bytes.slice(), created: this.clock.now() })
    this.objects.set(fullKey, versions)
    return handle
  }

  /** Flips bytes of the stored primary version, simulating bit rot or a broken upload. */
  corrupt(fullKey: string): boolean {
    const v = this.objects.get(fullKey)?.[0]
    if (!v) return false
    const bytes = v.bytes.slice()
    if (bytes.length === 0) v.bytes = new Uint8Array([0])
    else {
      bytes[0] = (bytes[0] ?? 0) ^ 0xff
      v.bytes = bytes
    }
    return true
  }

  read(fullKey: string, handle?: string): Uint8Array | null {
    const versions = this.objects.get(fullKey)
    if (!versions) return null
    const v = handle === undefined ? versions[0] : versions.find((x) => x.handle === handle)
    return v ? v.bytes.slice() : null
  }

  remove(fullKey: string): void {
    this.objects.delete(fullKey)
  }

  /** Sorted full keys with their versions (one Entry per version). */
  entries(prefix: string): { key: string; handle: string; size: number; created: number }[] {
    const out: { key: string; handle: string; size: number; created: number }[] = []
    for (const k of [...this.objects.keys()].sort()) {
      if (!k.startsWith(prefix)) continue
      for (const v of this.objects.get(k) ?? [])
        out.push({ key: k, handle: v.handle, size: v.bytes.length, created: v.created })
    }
    return out
  }

  keys(prefix = ''): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
}

export interface MemoryRemoteOptions {
  bucket: MemoryBucket
  prefix?: string
  /** Default page size when the caller does not pass one. */
  pageSize?: number
  type?: string
  endpoint?: string
  bucketName?: string
}

export interface MemoryRemote extends RemoteStore {
  readonly prefix: string
  readonly calls: { list: number; pages: number; get: number; put: number; delete: number }
  /** Not part of RemoteStore: only an explicit user action (removing an old plaintext root) deletes. */
  delete(key: Key): Promise<void>
}

/** RemoteStore over a MemoryBucket, with S3-like pagination (each page continues after the last key seen). */
export function memoryRemote(o: MemoryRemoteOptions): MemoryRemote {
  const prefix = o.prefix ? `${o.prefix.replace(/\/+$/, '')}/` : ''
  const calls = { list: 0, pages: 0, get: 0, put: 0, delete: 0 }
  const id = destinationId({ type: o.type ?? 'memory', endpoint: o.endpoint, bucket: o.bucketName, prefix: o.prefix })
  return {
    id,
    prefix,
    calls,
    list(listPrefix, lo) {
      calls.list++
      const pageSize = Math.max(1, lo?.pageSize ?? o.pageSize ?? 1000)
      const full = prefix + listPrefix
      const startAfter = lo?.startAfter === undefined ? undefined : prefix + lo.startAfter
      const createdAfter = lo?.createdAfter
      return {
        async *[Symbol.asyncIterator]() {
          let after: { key: string; handle: string } | undefined
          for (;;) {
            calls.pages++
            const all = o.bucket
              .entries(full)
              .filter(
                (e) =>
                  (startAfter === undefined || e.key > startAfter) &&
                  (createdAfter === undefined || e.created > createdAfter) &&
                  (after === undefined || e.key > after.key || (e.key === after.key && e.handle > after.handle)),
              )
            const page = all.slice(0, pageSize)
            for (const e of page) yield { key: e.key.slice(prefix.length), size: e.size, handle: e.handle } as Entry
            const last = page[page.length - 1]
            if (!last || all.length <= pageSize) return
            after = { key: last.key, handle: last.handle }
          }
        },
      }
    },
    async get(e) {
      calls.get++
      return o.bucket.read(prefix + e.key, e.handle)
    },
    async put(key, body) {
      calls.put++
      o.bucket.write(prefix + key, body)
    },
    async delete(key) {
      calls.delete++
      o.bucket.remove(prefix + key)
    },
  }
}
