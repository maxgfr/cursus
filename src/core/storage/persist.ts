/** Subset of StorageManager we rely on; injectable for tests. */
export interface StorageLike {
  persist?(): Promise<boolean>
  persisted?(): Promise<boolean>
  estimate?(): Promise<{ usage?: number; quota?: number }>
}

const defaultStorage = (): StorageLike | undefined => globalThis.navigator?.storage

/** Asks the browser to keep our data under storage pressure. false when unsupported or refused. */
export async function requestPersistence(storage: StorageLike | undefined = defaultStorage()): Promise<boolean> {
  if (!storage?.persist) return false
  if (storage.persisted && (await storage.persisted())) return true
  return storage.persist()
}

export async function persisted(storage: StorageLike | undefined = defaultStorage()): Promise<boolean> {
  return storage?.persisted ? storage.persisted() : false
}

/** Usage and quota in bytes; null when the platform does not tell. */
export async function estimate(
  storage: StorageLike | undefined = defaultStorage(),
): Promise<{ usage: number; quota: number } | null> {
  if (!storage?.estimate) return null
  const e = await storage.estimate()
  if (e.usage === undefined || e.quota === undefined) return null
  return { usage: e.usage, quota: e.quota }
}
