import type { LocalLog } from '../core/contracts/log'
import type { Clock, LocalStore, Rng } from '../core/contracts/ports'
import type { Key, RemoteStore } from '../core/contracts/remote'
import { createKeyring, type DestinationKeyring } from '../core/crypto/keyring'
import { createSealer } from '../core/crypto/sealer'
import { type Secrets, secretsVault } from '../core/storage/secrets'
import { createSyncEngine, type SyncEngineImpl, type SyncEngineOptions } from '../core/sync/engine'
import type { SyncScheduler } from '../core/sync/scheduler'

/**
 * The destination registry: what this device remembers about its destinations, and how they join the
 * sync engine. Loaded with the engine (after the first paint), at boot, whatever screen the app opens on.
 */

/** What the registry needs from the running app (the workspace runtime provides all of it). */
export interface Host {
  readonly store: LocalStore
  readonly log: Pick<LocalLog, 'keys' | 'bytes'>
  readonly clock: Clock
  readonly rng: Rng
  seal(): Promise<void>
}

/** A failure the user can act on; the screen shows `sync.<code>` in the current language. */
export type DestinationErrorCode = 'errUnavailable' | 'errNoState' | 'errNoFolders'

export class DestinationError extends Error {
  constructor(readonly code: DestinationErrorCode) {
    super(code)
    this.name = 'DestinationError'
  }
}

/**
 * A destination as this device remembers it (device vault only: it holds credentials, never the Y.Doc).
 * The id is the provider's identity hash, so the same bucket and prefix is the same destination everywhere.
 */
export type DestRecord =
  | {
      kind: 's3'
      id: string
      label: string
      endpoint: string
      region: string
      bucket: string
      prefix: string
      accessKeyId: string
      secretAccessKey: string
      paused?: boolean
      sealed?: boolean
    }
  | {
      kind: 'gdrive'
      id: string
      label: string
      rootName: string
      clientId: string
      clientSecret?: string
      secretName: string
      paused?: boolean
      sealed?: boolean
    }
  | {
      kind: 'dropbox'
      id: string
      label: string
      clientId: string
      secretName: string
      root: string
      paused?: boolean
      sealed?: boolean
    }
  | {
      kind: 'cloudkit'
      id: string
      label: string
      container: string
      environment: 'development' | 'production'
      apiToken: string
      paused?: boolean
      sealed?: boolean
    }
  | { kind: 'folder'; id: string; label: string; paused?: boolean; sealed?: boolean }
  | { kind: 'icloud'; id: string; label: string; paused?: boolean; sealed?: boolean }

export type DestKind = DestRecord['kind']

/** A record before its identity is known (computed from the provider settings when saved). */
export type DestDraft = { [K in DestKind]: Omit<Extract<DestRecord, { kind: K }>, 'id'> & { id?: string } }[DestKind]

const RECORD = 'dest:'
const DRAFT = 'dest-draft:'

export const vault = (h: Host): Secrets => secretsVault(h.store)

export async function listRecords(h: Host): Promise<DestRecord[]> {
  const s = vault(h)
  const names = (await s.names()).filter((n) => n.startsWith(RECORD))
  const out: DestRecord[] = []
  for (const n of names) {
    const r = await s.get<DestRecord>(n)
    if (r) out.push(r)
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

export const getRecord = (h: Host, id: string): Promise<DestRecord | undefined> => vault(h).get<DestRecord>(RECORD + id)
export const saveRecord = (h: Host, r: DestRecord): Promise<void> => vault(h).set(RECORD + r.id, r)
export const deleteRecord = (h: Host, id: string): Promise<void> => vault(h).delete(RECORD + id)

/** An OAuth connection in flight: the record waits here until the provider sends the user back. */
export const saveDraft = (h: Host, state: string, r: DestDraft): Promise<void> => vault(h).set(DRAFT + state, r)
export async function takeDraft(h: Host, state: string): Promise<DestDraft | undefined> {
  const r = await vault(h).get<DestDraft>(DRAFT + state)
  if (r) await vault(h).delete(DRAFT + state)
  return r
}

const keyrings = new WeakMap<LocalStore, Map<string, DestinationKeyring>>()

/** One keyring per sealed destination for the page's lifetime (unlocked keys stay in the vault). */
export function keyringFor(h: Host, destId: string): DestinationKeyring {
  let rings = keyrings.get(h.store)
  if (!rings) {
    rings = new Map()
    keyrings.set(h.store, rings)
  }
  let k = rings.get(destId)
  if (!k) {
    k = createKeyring({ secrets: vault(h), destId, rng: h.rng })
    rings.set(destId, k)
  }
  return k
}

/** The engine every device runs: sealed destinations open and seal with the WebCrypto sealer. */
export function createAppEngine(o: Omit<SyncEngineOptions, 'sealer'>): SyncEngineImpl {
  return createSyncEngine({ ...o, sealer: createSealer(o.rng) })
}

/** The OAuth return page put `{ params, receivedAt }` under this key of `kv`; reading it removes it. */
export async function takeCallback(h: Host, key: string): Promise<Record<string, string> | undefined> {
  const v = await h.store.read(['kv'], (tx) =>
    tx.get<{ params: Record<string, string>; receivedAt: number }>('kv', key),
  )
  if (v === undefined) return undefined
  await h.store.commit([{ delete: 'kv', key }])
  return v.params
}

const webFetch = (input: string | Request, init?: RequestInit) => fetch(input, init)

/** Builds the remote store a record describes; null when the device lost what it needs (a folder handle). */
export async function buildRemote(h: Host, r: DestRecord): Promise<RemoteStore | null> {
  switch (r.kind) {
    case 's3': {
      const { s3Remote } = await import('../core/sync/providers/s3')
      return s3Remote({
        endpoint: r.endpoint,
        region: r.region,
        bucket: r.bucket,
        prefix: r.prefix,
        accessKeyId: r.accessKeyId,
        secretAccessKey: r.secretAccessKey,
      })
    }
    case 'gdrive': {
      const [{ gdriveRemote }, { gdriveTokens }] = await Promise.all([
        import('../core/sync/providers/gdrive'),
        import('../core/sync/providers/gdriveAuth'),
      ])
      const tokens = gdriveTokens({ fetch: webFetch, clock: h.clock, secrets: vault(h), secretName: r.secretName })
      return gdriveRemote({ fetch: webFetch, tokens, rootName: r.rootName })
    }
    case 'dropbox': {
      const [{ dropboxRemote }, { dropboxSession }] = await Promise.all([
        import('../core/sync/providers/dropbox'),
        import('../core/sync/providers/dropboxAuth'),
      ])
      const tokens = dropboxSession({
        fetch: webFetch,
        clientId: r.clientId,
        secrets: vault(h),
        clock: h.clock,
        name: r.secretName,
      })
      return dropboxRemote({ fetch: webFetch, tokens, clock: h.clock, root: r.root })
    }
    case 'cloudkit': {
      const [{ cloudkitRemote }, { cloudkitAuth }] = await Promise.all([
        import('../core/sync/providers/cloudkit'),
        import('../core/sync/providers/cloudkitAuth'),
      ])
      return cloudkitRemote({
        container: r.container,
        environment: r.environment,
        apiToken: r.apiToken,
        fetch: webFetch,
        auth: cloudkitAuth(cloudkitAuthOptions(h, r)),
      })
    }
    case 'folder':
    case 'icloud': {
      const { FsStore, idbFsPersist } = await import('../core/sync/providers/fs')
      const persist = idbFsPersist(h.store)
      const root = await persist.loadHandle(r.id)
      if (!root) return null
      return new FsStore({ root, persist, type: r.kind, label: r.label })
    }
  }
}

export function cloudkitAuthOptions(h: Host, r: Extract<DestRecord, { kind: 'cloudkit' }>) {
  return {
    container: r.container,
    environment: r.environment,
    apiToken: r.apiToken,
    secrets: vault(h),
    fetch: webFetch,
    takeCallbackParams: () => takeCallback(h, 'oauth:cloudkit'),
  }
}

/** Adds a record's destination to the running engine (no-op when it is already there). */
export async function attach(h: Host, engine: SyncEngineImpl, r: DestRecord): Promise<boolean> {
  if (engine.destIds().includes(r.id)) return true
  const remote = await buildRemote(h, r)
  if (!remote || engine.destIds().includes(r.id)) return remote !== null
  engine.addDest({
    remote,
    id: r.id,
    label: r.label,
    paused: r.paused === true,
    sealed: r.sealed === true,
    ...(r.sealed ? { keyring: keyringFor(h, r.id) } : {}),
  })
  return true
}

const restored = new WeakMap<SyncEngineImpl, Promise<void>>()

/**
 * Re-attaches every remembered destination once per engine, then asks for a round. Destinations the
 * device can no longer open (a folder whose permission is gone) are left out until reconnected.
 */
export function restoreDestinations(h: Host, engine: SyncEngineImpl, scheduler: SyncScheduler): Promise<void> {
  let p = restored.get(engine)
  if (!p) {
    p = (async () => {
      let added = false
      for (const r of await listRecords(h)) if (await attach(h, engine, r)) added = true
      if (added) {
        await engine.refresh()
        scheduler.trigger('manual')
      }
    })()
    restored.set(engine, p)
    p.catch(() => restored.delete(engine))
  }
  return p
}

/** Saves the record under its provider identity, attaches it, and returns it. */
export async function commit(h: Host, engine: SyncEngineImpl, r: DestDraft): Promise<DestRecord> {
  const draft = { ...r, id: r.id ?? '' } as DestRecord
  const remote = await buildRemote(h, draft)
  if (!remote) throw new DestinationError('errUnavailable')
  const rec = { ...draft, id: remote.id } as DestRecord
  await saveRecord(h, rec)
  if (engine.destIds().includes(rec.id)) engine.removeDest(rec.id)
  await attach(h, engine, rec)
  await engine.refresh()
  return rec
}

/**
 * Back from a provider with `?oauth=<key>`: finishes the pending Drive or Dropbox connection (CloudKit
 * takes its own token when it next syncs). Returns the connected record, or null when nothing was pending.
 */
export async function finishOAuth(h: Host, engine: SyncEngineImpl, key: string): Promise<DestRecord | null> {
  if (key === 'oauth:cloudkit') return null
  const params = await takeCallback(h, key)
  const state = params?.state
  if (!params || !state) return null
  const draft = await takeDraft(h, state)
  if (!draft) return null
  if (draft.kind === 'gdrive') {
    const { finishAuth } = await import('../core/sync/providers/gdriveAuth')
    await finishAuth({
      fetch: webFetch,
      clock: h.clock,
      secrets: vault(h),
      client: { clientId: draft.clientId, ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}) },
      params,
    })
  } else if (draft.kind === 'dropbox') {
    const { finishDropbox } = await import('../core/sync/providers/dropboxAuth')
    await finishDropbox({ fetch: webFetch, clientId: draft.clientId, secrets: vault(h), clock: h.clock, params })
  } else {
    return null
  }
  return commit(h, engine, draft)
}

/** The `?oauth=<key>` a provider sent the user back with, if any. */
export const pendingOAuthKey = (): string | null => new URL(location.href).searchParams.get('oauth')

/** Drops `?oauth=` from the address once handled, keeping the route. */
export function clearOAuthParam(): void {
  const url = new URL(location.href)
  if (!url.searchParams.has('oauth')) return
  url.searchParams.delete('oauth')
  history.replaceState(history.state, '', url.href)
}

/** What finishing an OAuth return at boot produced: the connected destination, or why it failed. */
export type OAuthOutcome = { label: string } | { error: unknown }

/**
 * At boot, wherever the app opens: every remembered destination rejoins the engine, and a pending
 * OAuth return is finished. Resolves to that outcome (null when no return was pending).
 */
export async function bootDestinations(
  h: Host,
  engine: SyncEngineImpl,
  scheduler: SyncScheduler,
  oauthKey: string | null,
): Promise<OAuthOutcome | null> {
  await restoreDestinations(h, engine, scheduler)
  if (oauthKey === null) return null
  try {
    const rec = await finishOAuth(h, engine, oauthKey)
    if (!rec) return null
    scheduler.trigger('manual')
    return { label: rec.label }
  } catch (error) {
    return { error }
  }
}

/** Seals pending edits, runs one round per destination now, and recounts what is protected. */
export async function syncNow(h: Host, engine: SyncEngineImpl, scheduler: SyncScheduler): Promise<void> {
  await h.seal()
  scheduler.trigger('manual')
  await scheduler.whenIdle()
  await engine.refresh()
}

/**
 * Pulls everything from a one-off store (a backup file, a picked folder) into this library, then forgets
 * it. Counts what this device did not have before; a read-only store refusing our uploads is expected.
 */
export async function absorb(
  h: Host,
  engine: SyncEngineImpl,
  remote: RemoteStore,
): Promise<{ added: number; error?: string }> {
  const before = (await h.log.keys()).size
  const id = engine.addDest({ remote, label: remote.id, paused: false })
  let error: string | undefined
  try {
    await engine.round(id)
    const st = engine.status().dests.find((d) => d.id === id)
    if (st?.error && st.error.kind !== 'permission') error = st.error.message
    if (st?.reason === 'workspace') error = 'workspace'
  } catch (e) {
    if (!(e instanceof Error && 'kind' in e && e.kind === 'permission'))
      error = e instanceof Error ? e.message : String(e)
  } finally {
    engine.removeDest(id)
    await engine.refresh()
  }
  const added = (await h.log.keys()).size - before
  return error === undefined ? { added } : { added, error }
}

/** A `.cursus` archive, and the files its notes refer to that this device does not hold (so it lacks too). */
export interface Backup {
  bytes: Uint8Array
  /** Files (PDFs, images) referenced by the library but not on this device yet: not in the archive. */
  missingFiles: number
}

/**
 * Writes this whole library (log, files, key envelopes) into a `.cursus` archive. The engine lays down
 * the markers, envelopes and every file this device holds; a local backup is not bound by the remote
 * rule that holds a segment back until its files are confirmed, so every segment the device has goes in,
 * verbatim. Files the device never received are counted, not hidden.
 */
export async function exportBackup(h: Host, engine: SyncEngineImpl): Promise<Backup> {
  const [{ zipStore }, { bmanKey }, { blobStore }] = await Promise.all([
    import('../core/sync/providers/zip'),
    import('../core/log/codec'),
    import('../core/log/blobs'),
  ])
  await h.seal()
  const zip = zipStore({ label: `export-${h.rng.id()}` })
  const id = engine.addDest({ remote: zip, label: 'export', paused: false })
  try {
    // Files, manifests and markers settle in a few rounds; segments held back for absent files stay deferred.
    for (let i = 0; i < 6; i++) {
      const r = await engine.round(id)
      if (r.deferred === 0 && r.up === 0) break
    }
  } finally {
    engine.removeDest(id)
    await engine.refresh()
  }
  const inZip = new Set<Key>()
  for await (const e of zip.list('')) inZip.add(e.key)
  const blobs = blobStore(h.store)
  // Every segment and checkpoint this device holds, as stored.
  for (const key of await h.log.keys()) {
    if (inZip.has(key)) continue
    const bytes = await h.log.bytes(key)
    if (bytes === null) throw new Error(`Local log lost ${key} during export`)
    await zip.put(key, bytes)
    inZip.add(key)
  }
  // Every file chunk and manifest it holds (the engine already sent them; this only makes sure).
  const fileKeys = await h.store.read(['chunks', 'bmans'], (tx) =>
    Promise.all([tx.getAllKeys('chunks'), tx.getAllKeys('bmans')]),
  )
  for (const key of fileKeys.flat()) {
    if (typeof key !== 'string' || inZip.has(key)) continue
    const bytes = await blobs.read(key)
    if (bytes === null) throw new Error(`Local file store lost ${key} during export`)
    await zip.put(key, bytes)
    inZip.add(key)
  }
  // Files referenced by the library but absent from this device: their manifests are not in the archive.
  const rows = await h.store.read(['segments'], (tx) => tx.getAll<{ header?: { blobRefs?: string[] } }>('segments'))
  const missing = new Set<string>()
  for (const row of rows)
    for (const ref of row.header?.blobRefs ?? []) {
      if (inZip.has(bmanKey(ref))) continue
      if ((await blobs.read(bmanKey(ref))) === null) missing.add(ref)
    }
  return { bytes: zip.toBytes(), missingFiles: missing.size }
}

/** Saves bytes as a file through a temporary link. */
export function download(bytes: Uint8Array | string, name: string, type: string): void {
  const part: BlobPart = typeof bytes === 'string' ? bytes : new Uint8Array(bytes)
  const url = URL.createObjectURL(new Blob([part], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const fileStamp = (now: number): string => new Date(now).toISOString().slice(0, 10)

export type { Key }
