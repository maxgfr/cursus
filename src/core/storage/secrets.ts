import type { LocalStore } from '../contracts/ports'

/**
 * Device-only vault for tokens and keys (store `secrets`). Never written to the Y.Doc,
 * never synced: values may be CryptoKey objects, which IndexedDB stores without exporting them.
 */
export interface Secrets {
  get<T = unknown>(name: string): Promise<T | undefined>
  set(name: string, value: unknown): Promise<void>
  delete(name: string): Promise<void>
  names(): Promise<string[]>
}

const PREFIX = 'cursus-'

function keyOf(name: string): string {
  if (name.length === 0) throw new RangeError('Secret name must not be empty')
  return PREFIX + name
}

export function secretsVault(store: LocalStore): Secrets {
  return {
    get: <T>(name: string) => store.read(['secrets'], (tx) => tx.get<T>('secrets', keyOf(name))),
    set: (name, value) => store.commit([{ put: 'secrets', key: keyOf(name), value }]),
    delete: (name) => store.commit([{ delete: 'secrets', key: keyOf(name) }]),
    async names() {
      const keys = await store.read(['secrets'], (tx) => tx.getAllKeys('secrets'))
      return keys
        .filter((k): k is string => typeof k === 'string' && k.startsWith(PREFIX))
        .map((k) => k.slice(PREFIX.length))
    },
  }
}
