import { EnvelopeError } from '../contracts/errors'
import type { BlobStore } from '../contracts/log'
import type { LocalStore } from '../contracts/ports'
import type { Key } from '../contracts/remote'
import { BLOB_PREFIX, blobKey, bmanKey, parseKey, sha256Hex } from './codec'

export const CHUNK_SIZE = 4 * 1024 * 1024

/** File manifest stored at `bman/<h64>`; its own sha256 is the blob id. */
export interface Manifest {
  v: 1
  mime: string
  size: number
  chunks: string[]
}

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

export const blobRef = (id: string): string => `${BLOB_PREFIX}${id}`

function manifestBytes(m: Manifest): Uint8Array {
  return enc.encode(JSON.stringify({ v: m.v, mime: m.mime, size: m.size, chunks: m.chunks }))
}

/** Throws EnvelopeError 'version' on anything this build does not understand. */
export function parseManifest(bytes: Uint8Array): Manifest {
  let x: unknown
  try {
    x = JSON.parse(dec.decode(bytes))
  } catch (e) {
    throw new EnvelopeError('version', `Undecodable manifest: ${String(e)}`)
  }
  const m = (x ?? {}) as Record<string, unknown>
  const ok =
    typeof x === 'object' &&
    m.v === 1 &&
    typeof m.mime === 'string' &&
    typeof m.size === 'number' &&
    Array.isArray(m.chunks) &&
    m.chunks.every((c) => typeof c === 'string' && /^[0-9a-f]{64}$/.test(c))
  if (!ok) throw new EnvelopeError('version', 'Unknown manifest shape')
  return x as Manifest
}

/**
 * Content-addressed files: 4 MiB chunks then a manifest. `put` resolves only once chunks and manifest
 * are durably stored, so callers await it BEFORE the Yjs transaction that references the id.
 */
export function blobStore(store: LocalStore): BlobStore & { manifest(id: string): Promise<Manifest | null> } {
  const manifest = async (id: string): Promise<Manifest | null> => {
    const bytes = await store.read(['bmans'], (tx) => tx.get<Uint8Array>('bmans', bmanKey(id)))
    return bytes ? parseManifest(bytes) : null
  }
  return {
    manifest,
    async put(data, mime) {
      const chunks: string[] = []
      const ops: Parameters<LocalStore['commit']>[0] = []
      for (let off = 0; off < data.length; off += CHUNK_SIZE) {
        const chunk = data.slice(off, off + CHUNK_SIZE)
        const h = sha256Hex(chunk)
        chunks.push(h)
        ops.push({ put: 'chunks', key: blobKey(h), value: chunk })
      }
      const mb = manifestBytes({ v: 1, mime, size: data.length, chunks })
      const id = sha256Hex(mb)
      ops.push({ put: 'bmans', key: bmanKey(id), value: mb })
      await store.commit(ops)
      return id
    },
    async get(id) {
      const m = await manifest(id)
      if (!m) return null
      const parts = await store.read(['chunks'], (tx) =>
        Promise.all(m.chunks.map((h) => tx.get<Uint8Array>('chunks', blobKey(h)))),
      )
      const present: Uint8Array[] = []
      for (const p of parts) {
        if (!p) return null
        present.push(p)
      }
      return new Blob(present as BlobPart[], { type: m.mime })
    },
    async objectKeys(id) {
      const m = await manifest(id)
      if (!m) return []
      return [...new Set(m.chunks)].map(blobKey).concat(bmanKey(id))
    },
    async read(key: Key) {
      const p = parseKey(key)
      if (p?.kind === 'blob') return (await store.read(['chunks'], (tx) => tx.get<Uint8Array>('chunks', key))) ?? null
      if (p?.kind === 'bman') return (await store.read(['bmans'], (tx) => tx.get<Uint8Array>('bmans', key))) ?? null
      return null
    },
    async ingest(key, body) {
      const p = parseKey(key)
      if (p?.kind !== 'blob' && p?.kind !== 'bman') throw new RangeError(`Not a blob key: ${key}`)
      if (sha256Hex(body) !== p.h64) throw new EnvelopeError('hash', `Hash mismatch for ${key}`)
      if (p.kind === 'bman') {
        parseManifest(body)
        await store.commit([{ put: 'bmans', key, value: body }])
      } else {
        await store.commit([{ put: 'chunks', key, value: body }])
      }
    },
  }
}
