/**
 * Raw, read-only copy of a local IndexedDB database (the live one or a failed one kept aside), for
 * support or a manual rescue. Never deletes, never upgrades: a database that does not exist is not created.
 * The `secrets` store (tokens, keys) is left out.
 */

const SKIPPED = new Set(['secrets'])

function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function plain(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $bytes: b64(v) }
  if (v instanceof ArrayBuffer) return { $bytes: b64(new Uint8Array(v)) }
  if (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey) return { $omitted: 'CryptoKey' }
  if (v instanceof Blob) return { $omitted: 'Blob', size: v.size }
  if (Array.isArray(v)) return v.map(plain)
  if (v !== null && typeof v === 'object') {
    if ('kind' in v && (v.kind === 'directory' || v.kind === 'file') && 'name' in v) return { $omitted: 'handle' }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  }
  return v
}

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

function openExisting(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    let created = false
    req.onupgradeneeded = () => {
      created = true
      req.transaction?.abort()
    }
    req.onerror = () => reject(created ? new Error(`No database ${name}`) : req.error)
    req.onblocked = () => reject(new Error(`Database ${name} is blocked by another tab`))
    req.onsuccess = () => resolve(req.result)
  })
}

export async function localDatabases(): Promise<string[]> {
  if (!('databases' in indexedDB)) return ['cursus-v1']
  const all = await indexedDB.databases()
  return all
    .map((d) => d.name ?? '')
    .filter((n) => n.startsWith('cursus'))
    .sort()
}

export async function dumpDatabase(name: string): Promise<string> {
  const db = await openExisting(name)
  try {
    const stores: Record<string, { keys: unknown[]; values: unknown[] }> = {}
    const names = [...db.objectStoreNames].filter((s) => !SKIPPED.has(s))
    for (const s of names) {
      const tx = db.transaction(s, 'readonly')
      const store = tx.objectStore(s)
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
      stores[s] = { keys: keys.map(plain), values: values.map(plain) }
    }
    return JSON.stringify({ database: name, version: db.version, exportedAt: new Date().toISOString(), stores })
  } finally {
    db.close()
  }
}
