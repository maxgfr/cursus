export type StoreName = 'pending' | 'segments' | 'snapshot' | 'chunks' | 'bmans' | 'dests' | 'secrets' | 'kv'
export type IdbKey = string | number

export interface ReadTx {
  get<T>(store: StoreName, key: IdbKey): Promise<T | undefined>
  getAll<T>(store: StoreName, range?: { lower?: IdbKey; upper?: IdbKey }): Promise<T[]>
  getAllKeys(store: StoreName, range?: { lower?: IdbKey; upper?: IdbKey }): Promise<IdbKey[]>
  count(store: StoreName): Promise<number>
}

export type WriteOp =
  | { put: StoreName; key?: IdbKey; value: unknown }
  | { add: StoreName; key?: IdbKey; value: unknown }
  | { delete: StoreName; key: IdbKey }
  | { deleteRange: StoreName; upTo: IdbKey }

export interface Clock {
  now(): number
}
export interface Rng {
  u32(): number
  id(): string
} // graine en test, crypto en prod
export interface Locks {
  run<T>(name: string, fn: () => Promise<T>, o?: { ifAvailable?: boolean }): Promise<T | null>
}
export interface LocalStore {
  // IDB + mémoire, même suite de contrat
  read<T>(stores: StoreName[], fn: (tx: ReadTx) => Promise<T>): Promise<T> // uniquement des requêtes IDB dans fn
  commit(ops: WriteOp[]): Promise<void>
} // 1 transaction 'strict', tout ou rien
