import { unzipSync, Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { RemoteError } from '../../contracts/errors'
import type { Entry, Key, RemoteStore } from '../../contracts/remote'
import { destinationId } from '../identity'

/** Media type and extension of a workspace archive. */
export const CURSUS_EXT = '.cursus'
export const CURSUS_MIME = 'application/vnd.cursus+zip'

/** `mirror/` is a derived, rewritable view: it never goes into an archive. */
const DERIVED = 'mirror/'

/** Human-readable description written at the root of every archive; not a remote key. */
export const README_NAME = 'README.txt'
export const README = [
  'Cursus workspace backup (.cursus)',
  '',
  'This is a zip archive. Every entry is one object of a Cursus sync destination, stored',
  'byte for byte under its remote key:',
  '  fmt/v1             format marker',
  '  ws/<id>            workspace descriptor',
  '  keys/<hash>.json   wrapped encryption keys (when the workspace is encrypted)',
  '  seg/<dev>/<n>-<h>.seg   append-only log segments (Yjs updates in an envelope)',
  '  ckpt/<dev>/<h>.ckpt     checkpoints covering older segments',
  '  blob/..., bman/...      attachments and their manifests',
  '',
  'An incremental backup only carries the objects added since the previous export.',
  'Importing merges: objects already present are never overwritten, so importing an old',
  'backup after newer edits loses nothing.',
  '',
].join('\n')

export interface ZipStore extends RemoteStore {
  /** Number of objects held. */
  readonly size: number
  /** The archive bytes; objects are stored uncompressed when already sealed (high entropy). */
  toBytes(): Uint8Array
}

export class ZipFormatError extends Error {
  constructor(m: string) {
    super(m)
    this.name = 'ZipFormatError'
  }
}

/**
 * A `.cursus` file as a RemoteStore: one zip entry per remote key, bytes stored verbatim.
 * Opening an archive never rewrites what it holds; `put` on an existing key is a no-op when
 * the bytes are equal and refused otherwise (archive keys are immutable).
 */
export function zipStore(o: { bytes?: Uint8Array; label?: string } = {}): ZipStore {
  const objects = new Map<Key, Uint8Array>()
  if (o.bytes) {
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(o.bytes)
    } catch (err) {
      throw new ZipFormatError(`Not a ${CURSUS_EXT} archive: ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const [name, body] of Object.entries(files)) {
      if (name.endsWith('/') || name === README_NAME) continue
      objects.set(name, body)
    }
  }
  const id = destinationId({ type: 'zip', bucket: o.label })
  return {
    id,
    get size() {
      return objects.size
    },
    list(prefix, lo) {
      const startAfter = lo?.startAfter
      return {
        async *[Symbol.asyncIterator]() {
          // createdAfter is ignored: an archive has no server time, so every key is "at least" returned.
          for (const key of [...objects.keys()].sort()) {
            if (!key.startsWith(prefix)) continue
            if (startAfter !== undefined && key <= startAfter) continue
            const body = objects.get(key) as Uint8Array
            yield { key, size: body.length, handle: key } as Entry
          }
        },
      }
    },
    async get(e) {
      const body = objects.get(e.key)
      return body ? body.slice() : null
    },
    async put(key, body) {
      const prev = objects.get(key)
      if (prev) {
        if (sameBytes(prev, body)) return
        throw new RemoteError('permission', `Archive key is immutable: ${key}`)
      }
      objects.set(key, body.slice())
    },
    toBytes() {
      const chunks: Uint8Array[] = []
      const state: { failure: Error | null } = { failure: null }
      const zip = new Zip((err, chunk) => {
        if (err) state.failure = err
        else chunks.push(chunk)
      })
      const add = (name: string, body: Uint8Array, deflate: boolean) => {
        const f = deflate ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
        // Fixed mtime keeps archives byte-identical for identical contents.
        f.mtime = FIXED_MTIME
        zip.add(f)
        f.push(body, true)
      }
      add(README_NAME, new TextEncoder().encode(README), true)
      for (const key of [...objects.keys()].sort()) add(key, objects.get(key) as Uint8Array, compressible(key))
      zip.end()
      if (state.failure) throw state.failure
      return concat(chunks)
    },
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

const FIXED_MTIME = new Date(Date.UTC(2000, 0, 1))

/** Sealed segments and blobs are ciphertext; text-like keys are worth compressing. */
function compressible(key: Key): boolean {
  return key.startsWith('fmt/') || key.startsWith('ws/') || key.startsWith('keys/') || key.endsWith('.json')
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Builds a `.cursus` archive from a store. Full when `exclude` is empty; incremental when it
 * holds the keys an earlier archive already carries. Bytes are copied as read, never rewritten.
 */
export async function exportArchive(
  from: RemoteStore,
  o: { exclude?: ReadonlySet<Key>; label?: string } = {},
): Promise<{ bytes: Uint8Array; keys: Key[] }> {
  const out = zipStore({ label: o.label })
  const keys: Key[] = []
  for await (const e of from.list('')) {
    if (e.key.startsWith(DERIVED) || o.exclude?.has(e.key) || keys.includes(e.key)) continue
    const body = await from.get(e)
    if (body === null) throw new RemoteError('network', `Listed key vanished during export: ${e.key}`)
    await out.put(e.key, body)
    keys.push(e.key)
  }
  return { bytes: out.toBytes(), keys }
}

/** Keys an archive carries, to pass as `exclude` for the next incremental export. */
export async function archiveKeys(bytes: Uint8Array): Promise<Set<Key>> {
  const z = zipStore({ bytes })
  const keys = new Set<Key>()
  for await (const e of z.list('')) keys.add(e.key)
  return keys
}

/**
 * Imports an archive as a pure union: keys missing from `to` are added, keys already present
 * are left untouched (never overwritten), derived `mirror/` entries are ignored.
 */
export async function importArchive(bytes: Uint8Array, to: RemoteStore): Promise<{ added: number; skipped: number }> {
  const z = zipStore({ bytes })
  const present = new Set<Key>()
  for await (const e of to.list('')) present.add(e.key)
  let added = 0
  let skipped = 0
  for await (const e of z.list('')) {
    if (e.key.startsWith(DERIVED) || present.has(e.key)) {
      skipped++
      continue
    }
    await to.put(e.key, (await z.get(e)) as Uint8Array)
    added++
  }
  return { added, skipped }
}
