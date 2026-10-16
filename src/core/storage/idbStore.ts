import { type IDBPDatabase, openDB } from 'idb'
import type { IdbKey, LocalStore, ReadTx, StoreName, WriteOp } from '../contracts/ports'

export const DB_NAME = 'cursus-v1'
export const DB_VERSION = 1
export const STORE_NAMES: readonly StoreName[] = [
  'pending',
  'segments',
  'snapshot',
  'chunks',
  'bmans',
  'dests',
  'secrets',
  'kv',
]

/** The device ran out of local storage: the caller keeps the data in memory and shows a blocking banner. */
export class LocalQuotaError extends Error {
  constructor(
    m: string,
    readonly cause?: unknown,
  ) {
    super(m)
    this.name = 'LocalQuotaError'
  }
}

/** Maps a raw IndexedDB failure to our error types (QuotaExceededError ⇒ LocalQuotaError). */
export function toStoreError(e: unknown): unknown {
  if (e instanceof LocalQuotaError) return e
  if (e instanceof Error && e.name === 'QuotaExceededError') return new LocalQuotaError(e.message, e)
  return e
}

/** The store was disposed (« Erase everything »): nothing is read or written any more, nothing reopens it. */
export class StoreDisposedError extends Error {
  constructor() {
    super('The local library was closed for good')
    this.name = 'StoreDisposedError'
  }
}

function isClosedError(e: unknown): boolean {
  return e instanceof Error && e.name === 'InvalidStateError'
}

function keyRange(range?: { lower?: IdbKey; upper?: IdbKey }): IDBKeyRange | undefined {
  if (!range) return undefined
  const { lower, upper } = range
  if (lower !== undefined && upper !== undefined) return IDBKeyRange.bound(lower, upper)
  if (lower !== undefined) return IDBKeyRange.lowerBound(lower)
  if (upper !== undefined) return IDBKeyRange.upperBound(upper)
  return undefined
}

export interface IdbStoreOptions {
  name?: string
  /** Another tab wants a newer schema: this connection is closed; show a banner. */
  onVersionChange?: () => void
  /** Our upgrade is blocked by an older tab. */
  onBlocked?: () => void
}

export interface IdbStore extends LocalStore {
  close(): void
  /**
   * Closes the connection for good: every later read or commit rejects with `StoreDisposedError` and the database
   * is never opened again, so a database deleted next stays deleted.
   */
  dispose(): void
}

export function idbStore(o: IdbStoreOptions = {}): IdbStore {
  const name = o.name ?? DB_NAME
  let conn: Promise<IDBPDatabase> | null = null
  let disposed = false

  const open = (): Promise<IDBPDatabase> => {
    if (disposed) return Promise.reject(new StoreDisposedError())
    if (conn) return conn
    const p = openDB(name, DB_VERSION, {
      upgrade(db) {
        for (const s of STORE_NAMES)
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { autoIncrement: true })
      },
      blocked: () => o.onBlocked?.(),
      blocking: () => {
        void p.then((db) => db.close())
        if (conn === p) conn = null
        o.onVersionChange?.()
      },
      terminated: () => {
        if (conn === p) conn = null
      },
    })
    conn = p
    p.then(
      // Opened while it was being disposed: let go of it at once.
      (db) => {
        if (disposed) db.close()
      },
      () => {
        if (conn === p) conn = null
      },
    )
    return p
  }

  /** Runs op; a connection terminated or closed under us is reopened and the op retried once. */
  const withDb = async <T>(op: (db: IDBPDatabase) => Promise<T>): Promise<T> => {
    try {
      return await op(await open())
    } catch (e) {
      if (disposed) throw new StoreDisposedError()
      if (!isClosedError(e)) throw toStoreError(e)
      conn = null
      try {
        return await op(await open())
      } catch (e2) {
        throw toStoreError(e2)
      }
    }
  }

  return {
    read<T>(stores: StoreName[], fn: (tx: ReadTx) => Promise<T>): Promise<T> {
      return withDb(async (db) => {
        const t = db.transaction(stores, 'readonly')
        const rtx: ReadTx = {
          get: async <V>(s: StoreName, k: IdbKey) => (await t.objectStore(s).get(k)) as V | undefined,
          getAll: async <V>(s: StoreName, r?: { lower?: IdbKey; upper?: IdbKey }) =>
            (await t.objectStore(s).getAll(keyRange(r))) as V[],
          getAllKeys: async (s, r) => (await t.objectStore(s).getAllKeys(keyRange(r))) as IdbKey[],
          count: (s) => t.objectStore(s).count(),
        }
        const out = await fn(rtx)
        await t.done
        return out
      })
    },
    commit(ops: WriteOp[]): Promise<void> {
      if (disposed) return Promise.reject(new StoreDisposedError())
      if (ops.length === 0) return Promise.resolve()
      return withDb(async (db) => {
        const names = new Set<StoreName>()
        for (const op of ops)
          names.add('put' in op ? op.put : 'add' in op ? op.add : 'delete' in op ? op.delete : op.deleteRange)
        const t = db.transaction([...names], 'readwrite', { durability: 'strict' })
        const reqs: Promise<unknown>[] = []
        for (const op of ops) {
          if ('put' in op) reqs.push(t.objectStore(op.put).put(op.value, op.key))
          else if ('add' in op) reqs.push(t.objectStore(op.add).add(op.value, op.key))
          else if ('delete' in op) reqs.push(t.objectStore(op.delete).delete(op.key))
          else reqs.push(t.objectStore(op.deleteRange).delete(IDBKeyRange.upperBound(op.upTo)))
        }
        // Any failing request aborts the whole transaction: all or nothing.
        const results = await Promise.allSettled([...reqs, t.done])
        const failed = results.find((r) => r.status === 'rejected')
        if (failed && failed.status === 'rejected') throw failed.reason
      })
    },
    close() {
      const p = conn
      conn = null
      if (p) void p.then((db) => db.close())
    },
    dispose() {
      disposed = true
      const p = conn
      conn = null
      if (p)
        void p.then(
          (db) => db.close(),
          () => undefined,
        )
    },
  }
}
