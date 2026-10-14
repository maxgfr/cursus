import { RemoteError } from '../../contracts/errors'
import type { LocalStore } from '../../contracts/ports'
import type { Entry, Key, RemoteStore } from '../../contracts/remote'
import { parseKey, sha256Hex } from '../../log/codec'
import { destinationId } from '../identity'

/**
 * The subset of the File System Access API the folder provider needs. A real
 * FileSystemDirectoryHandle fits it; Bun tests inject the in-memory fake (tests/support/fsHandle.ts).
 */
export interface FsFile {
  readonly size: number
  readonly lastModified: number
  arrayBuffer(): Promise<ArrayBuffer>
}
export interface FsWritable {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}
export interface FsFileHandle {
  readonly kind: 'file'
  readonly name: string
  getFile(): Promise<FsFile>
  createWritable(): Promise<FsWritable>
}
export interface FsDirHandle {
  readonly kind: 'directory'
  readonly name: string
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<FsDirHandle>
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FsFileHandle>
  values(): AsyncIterable<FsDirHandle | FsFileHandle>
  /** Chromium only; absent elsewhere (then access is assumed granted). */
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>
}

/**
 * Where the handle and the absorbed inbox hashes live across reloads (IndexedDB in the app: a
 * FileSystemDirectoryHandle is structured-cloneable, so it is stored as is).
 */
export interface FsPersist {
  saveHandle(destId: string, h: FsDirHandle): Promise<void>
  loadHandle(destId: string): Promise<FsDirHandle | null>
  absorbed(destId: string): Promise<ReadonlySet<string>>
  addAbsorbed(destId: string, hash: string): Promise<void>
}

export interface FsStoreOptions {
  root: FsDirHandle
  persist: FsPersist
  /** 'folder' for a local folder, 'icloud' for a folder inside iCloud Drive: same code, distinct destinations. */
  type?: 'folder' | 'icloud'
  /** Stable label the user gave the folder (handles have no path); part of the destination identity. */
  label?: string
}

export interface InboxFile {
  key: Key
  hash: string
  bytes: Uint8Array
}

export const INBOX = 'inbox/'

/** Names the browser or the OS leave in a folder: .DS_Store, iCloud placeholders, Chrome's .crswap files. */
export const ignoredName = (name: string): boolean => name.startsWith('.') || name.endsWith('.crswap')

/**
 * iCloud (and Dropbox, Finder) resolve a clash by renaming one side "x 2.seg". Such a copy fails the
 * strict parseKey while its original name passes: it is ignored, never read as a segment.
 */
export function isConflictCopy(key: Key): boolean {
  if (parseKey(key)) return false
  const original = key.replace(/ \d+(\.[^./ ]+)?$/, '$1')
  return original !== key && parseKey(original) !== null
}

function segments(key: Key): string[] {
  const parts = key.split('/')
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || ignoredName(p))
      throw new RangeError(`Key not storable in a folder: ${key}`)
  }
  return parts
}

/** DOMException names → RemoteError kinds; NotFound/TypeMismatch mean "absent" and are handled by callers. */
export function fsError(e: unknown, what: string): RemoteError {
  if (e instanceof RemoteError) return e
  const name = e instanceof Error ? e.name : ''
  const m = `${what}: ${e instanceof Error ? e.message : String(e)}`
  if (name === 'NotAllowedError' || name === 'SecurityError') return new RemoteError('permission', m)
  if (name === 'QuotaExceededError') return new RemoteError('quota', m)
  return new RemoteError('network', m)
}

const absent = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')

/**
 * RemoteStore over a directory handle: key `a/b/c` is file `c` in sub-folder `a/b`, written with
 * createWritable then close. No duplicates, no handles. A lost permission is a RemoteError
 * 'permission', which the engine shows as needs-permission. Nothing is ever deleted.
 */
export class FsStore implements RemoteStore {
  readonly id: string
  private readonly root: FsDirHandle
  private readonly persist: FsPersist

  constructor(o: FsStoreOptions) {
    this.root = o.root
    this.persist = o.persist
    this.id = destinationId({ type: o.type ?? 'folder', bucket: o.label ?? o.root.name })
  }

  /** Keeps the handle so the folder survives a reload; returns the store. */
  static async create(o: FsStoreOptions): Promise<FsStore> {
    const s = new FsStore(o)
    await o.persist.saveHandle(s.id, o.root)
    return s
  }

  /** Reopens a folder kept by `create`; null when it was never chosen. */
  static async restore(
    destId: string,
    persist: FsPersist,
    o: Omit<FsStoreOptions, 'root' | 'persist'> = {},
  ): Promise<FsStore | null> {
    const root = await persist.loadHandle(destId)
    return root ? new FsStore({ ...o, root, persist }) : null
  }

  /** Asks again for access; must run inside a user gesture. True when granted. */
  async requestPermission(): Promise<boolean> {
    if (!this.root.requestPermission) return true
    return (await this.root.requestPermission({ mode: 'readwrite' })) === 'granted'
  }

  private async granted(): Promise<void> {
    const p = this.root.queryPermission ? await this.root.queryPermission({ mode: 'readwrite' }) : 'granted'
    if (p !== 'granted') throw new RemoteError('permission', `No access to folder ${this.root.name} (${p})`)
  }

  private async dir(parts: string[], create: boolean): Promise<FsDirHandle | null> {
    let d = this.root
    for (const p of parts) {
      try {
        d = await d.getDirectoryHandle(p, { create })
      } catch (e) {
        if (!create && absent(e)) return null
        throw e
      }
    }
    return d
  }

  /** Files under `d` (path `base`) whose key can still match `prefix`, unsorted. */
  private async walk(d: FsDirHandle, base: string, prefix: string, out: { key: string; file: FsFile }[]) {
    for await (const h of d.values()) {
      if (ignoredName(h.name)) continue
      const key = base + h.name
      if (h.kind === 'file') {
        if (key.startsWith(prefix) && !isConflictCopy(key)) out.push({ key, file: await h.getFile() })
      } else {
        const sub = `${key}/`
        if (sub.startsWith(prefix) || prefix.startsWith(sub)) await this.walk(h, sub, prefix, out)
      }
    }
  }

  list(prefix: string, lo?: { startAfter?: Key; createdAfter?: number }): AsyncIterable<Entry> {
    return {
      [Symbol.asyncIterator]: async function* (this: FsStore) {
        const found: { key: string; file: FsFile }[] = []
        try {
          await this.granted()
          await this.walk(this.root, '', prefix, found)
        } catch (e) {
          throw fsError(e, `list ${prefix}`)
        }
        found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        for (const { key, file } of found) {
          if (lo?.startAfter !== undefined && key <= lo.startAfter) continue
          if (lo?.createdAfter !== undefined && file.lastModified <= lo.createdAfter) continue
          yield { key, size: file.size } as Entry
        }
      }.bind(this),
    }
  }

  async get(e: Entry): Promise<Uint8Array | null> {
    const parts = segments(e.key)
    const name = parts.pop() as string
    try {
      await this.granted()
      const d = await this.dir(parts, false)
      if (!d) return null
      const f = await (await d.getFileHandle(name)).getFile()
      return new Uint8Array(await f.arrayBuffer())
    } catch (err) {
      if (absent(err)) return null
      throw fsError(err, `get ${e.key}`)
    }
  }

  async put(key: Key, body: Uint8Array): Promise<void> {
    const parts = segments(key)
    const name = parts.pop() as string
    try {
      await this.granted()
      const d = (await this.dir(parts, true)) as FsDirHandle
      const w = await (await d.getFileHandle(name, { create: true })).createWritable()
      try {
        await w.write(body)
      } catch (e) {
        await w.abort()
        throw e
      }
      await w.close()
    } catch (e) {
      throw fsError(e, `put ${key}`)
    }
  }

  /** `inbox/*.cursus` files dropped by another device (iPad share sheet) and not absorbed yet. */
  async inbox(): Promise<InboxFile[]> {
    const done = await this.persist.absorbed(this.id)
    const out: InboxFile[] = []
    for await (const e of this.list(INBOX)) {
      if (e.key.includes('/', INBOX.length) || !e.key.endsWith('.cursus')) continue
      const bytes = await this.get(e)
      if (!bytes) continue
      const hash = sha256Hex(bytes)
      if (!done.has(hash)) out.push({ key: e.key, hash, bytes })
    }
    return out
  }

  /** Remembers an absorbed inbox file by content hash. The file itself is never deleted. */
  async markAbsorbed(hash: string): Promise<void> {
    await this.persist.addAbsorbed(this.id, hash)
  }
}

/** In-memory FsPersist, for tests and for browsers without IndexedDB. */
export function memoryFsPersist(): FsPersist {
  const handles = new Map<string, FsDirHandle>()
  const hashes = new Map<string, Set<string>>()
  return {
    async saveHandle(id, h) {
      handles.set(id, h)
    },
    async loadHandle(id) {
      return handles.get(id) ?? null
    },
    async absorbed(id) {
      return new Set(hashes.get(id))
    },
    async addAbsorbed(id, hash) {
      hashes.set(id, new Set(hashes.get(id)).add(hash))
    },
  }
}

const handleKey = (destId: string): string => `fs-handle:${destId}`
const absorbedKey = (destId: string): string => `fs-absorbed:${destId}`

/**
 * FsPersist in the local IndexedDB (`kv` store): the directory handle is stored as is (structured
 * clone keeps the browser's grant), the absorbed hashes as an array, both keyed by destination id.
 */
export function idbFsPersist(store: LocalStore): FsPersist {
  const hashes = (id: string) =>
    store.read(['kv'], (tx) => tx.get<string[]>('kv', absorbedKey(id))).then((h) => h ?? [])
  return {
    saveHandle: (id, h) => store.commit([{ put: 'kv', key: handleKey(id), value: h }]),
    async loadHandle(id) {
      return (await store.read(['kv'], (tx) => tx.get<FsDirHandle>('kv', handleKey(id)))) ?? null
    },
    async absorbed(id) {
      return new Set(await hashes(id))
    },
    async addAbsorbed(id, hash) {
      const next = [...new Set(await hashes(id)).add(hash)]
      await store.commit([{ put: 'kv', key: absorbedKey(id), value: next }])
    },
  }
}
