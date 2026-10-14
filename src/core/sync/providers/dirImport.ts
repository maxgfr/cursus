import { RemoteError } from '../../contracts/errors'
import type { Entry, Key, RemoteStore } from '../../contracts/remote'
import { destinationId } from '../identity'
import { fsError, INBOX, ignoredName, isConflictCopy } from './fs'

/**
 * A picked File. With `<input webkitdirectory>` (iPadOS 18.4+), `webkitRelativePath` is the path from
 * the picked folder's parent; with a plain multiple pick of `.cursus` files it is empty.
 */
export interface ImportedFile {
  readonly name: string
  readonly webkitRelativePath: string
  readonly size: number
  readonly lastModified: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * Read-only RemoteStore over picked files (Safari, Firefox, iOS Files/iCloud Drive): a one-shot
 * snapshot to pull from. A folder pick maps its contents to keys (the folder's own name is the
 * root); the fallback, several `.cursus` files, shows them as `inbox/<name>`.
 */
export class DirImportStore implements RemoteStore {
  readonly id: string
  private readonly byKey = new Map<Key, ImportedFile>()
  private readonly keys: Key[]

  constructor(files: Iterable<ImportedFile>) {
    let root = ''
    for (const f of files) {
      const key = DirImportStore.keyOf(f)
      if (key === null) continue
      if (f.webkitRelativePath) root ||= f.webkitRelativePath.split('/')[0] ?? ''
      this.byKey.set(key, f)
    }
    this.keys = [...this.byKey.keys()].sort()
    this.id = destinationId({ type: 'dir-import', bucket: root })
  }

  private static keyOf(f: ImportedFile): Key | null {
    if (!f.webkitRelativePath) return f.name.endsWith('.cursus') && !ignoredName(f.name) ? INBOX + f.name : null
    const rest = f.webkitRelativePath.split('/').slice(1)
    if (rest.length === 0 || rest.some((p) => p === '' || ignoredName(p))) return null
    const key = rest.join('/')
    return isConflictCopy(key) ? null : key
  }

  list(prefix: string, lo?: { startAfter?: Key; createdAfter?: number }): AsyncIterable<Entry> {
    const { byKey, keys } = this
    return {
      async *[Symbol.asyncIterator]() {
        for (const key of keys) {
          const f = byKey.get(key) as ImportedFile
          if (!key.startsWith(prefix)) continue
          if (lo?.startAfter !== undefined && key <= lo.startAfter) continue
          if (lo?.createdAfter !== undefined && f.lastModified <= lo.createdAfter) continue
          yield { key, size: f.size } as Entry
        }
      },
    }
  }

  async get(e: Entry): Promise<Uint8Array | null> {
    const f = this.byKey.get(e.key)
    if (!f) return null
    try {
      return new Uint8Array(await f.arrayBuffer())
    } catch (err) {
      throw fsError(err, `get ${e.key}`)
    }
  }

  async put(key: Key): Promise<void> {
    throw new RemoteError('permission', `Imported folder is read-only: ${key}`)
  }
}
