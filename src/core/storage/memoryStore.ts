import type { IdbKey, LocalStore, ReadTx, StoreName, WriteOp } from '../contracts/ports'
import { STORE_NAMES } from './idbStore'

/** IndexedDB key order: numbers before strings, numbers numerically, strings by code unit. */
export function compareKeys(a: IdbKey, b: IdbKey): number {
  if (typeof a !== typeof b) return typeof a === 'number' ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

interface Table {
  rows: Map<IdbKey, unknown>
  next: number
}

function inRange(k: IdbKey, range?: { lower?: IdbKey; upper?: IdbKey }): boolean {
  if (!range) return true
  if (range.lower !== undefined && compareKeys(k, range.lower) < 0) return false
  if (range.upper !== undefined && compareKeys(k, range.upper) > 0) return false
  return true
}

/** In-memory LocalStore with the same semantics as the IndexedDB one (structured clones, atomic commits). */
export function memoryStore(): LocalStore & { size(store: StoreName): number } {
  let tables = new Map<StoreName, Table>(STORE_NAMES.map((n) => [n, { rows: new Map(), next: 1 }]))
  const table = (t: Map<StoreName, Table>, n: StoreName): Table => {
    const found = t.get(n)
    if (!found) throw new DOMException(`Unknown store ${n}`, 'NotFoundError')
    return found
  }
  const sorted = (n: StoreName, range?: { lower?: IdbKey; upper?: IdbKey }): IdbKey[] =>
    [...table(tables, n).rows.keys()].filter((k) => inRange(k, range)).sort(compareKeys)

  const tx: ReadTx = {
    async get<T>(store: StoreName, key: IdbKey) {
      const v = table(tables, store).rows.get(key)
      return v === undefined ? undefined : (structuredClone(v) as T)
    },
    async getAll<T>(store: StoreName, range?: { lower?: IdbKey; upper?: IdbKey }) {
      const rows = table(tables, store).rows
      return sorted(store, range).map((k) => structuredClone(rows.get(k)) as T)
    },
    async getAllKeys(store, range) {
      return sorted(store, range)
    },
    async count(store) {
      return table(tables, store).rows.size
    },
  }

  const keyFor = (t: Table, key: IdbKey | undefined): IdbKey => {
    const k = key ?? t.next
    if (typeof k === 'number' && k >= t.next) t.next = Math.floor(k) + 1
    return k
  }

  return {
    async read<T>(stores: StoreName[], fn: (tx: ReadTx) => Promise<T>): Promise<T> {
      for (const s of stores) table(tables, s)
      return fn(tx)
    },
    async commit(ops: WriteOp[]): Promise<void> {
      const draft = new Map<StoreName, Table>()
      for (const [n, t] of tables) draft.set(n, { rows: new Map(t.rows), next: t.next })
      for (const op of ops) {
        if ('put' in op) {
          const t = table(draft, op.put)
          t.rows.set(keyFor(t, op.key), structuredClone(op.value))
        } else if ('add' in op) {
          const t = table(draft, op.add)
          if (op.key !== undefined && t.rows.has(op.key))
            throw new DOMException('Key already exists', 'ConstraintError')
          t.rows.set(keyFor(t, op.key), structuredClone(op.value))
        } else if ('delete' in op) {
          table(draft, op.delete).rows.delete(op.key)
        } else {
          const t = table(draft, op.deleteRange)
          for (const k of [...t.rows.keys()]) if (compareKeys(k, op.upTo) <= 0) t.rows.delete(k)
        }
      }
      tables = draft
    },
    size: (store) => table(tables, store).rows.size,
  }
}
