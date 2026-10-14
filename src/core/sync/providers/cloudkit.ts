import { RemoteError, type RemoteErrorKind } from '../../contracts/errors'
import type { Entry, Key, RemoteStore } from '../../contracts/remote'
import { sha256Hex } from '../../log/codec'
import { destinationId } from '../identity'

/**
 * RemoteStore over CloudKit Web Services (REST, private database, default zone). One object = one
 * `CursusObject {key, sha, size, data}` record whose name is the hash of the key, so `put` is an
 * idempotent forceReplace and there are never duplicates. Bodies above ASSET_THRESHOLD go to an Asset
 * field (assets/upload, then records/modify) because a record holds at most 1 MB.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** Where the user's web auth token comes from; `invalidate` drops it after AUTHENTICATION_REQUIRED. */
export interface CloudKitTokenSource {
  token(): Promise<string | null>
  invalidate(): Promise<void>
}

export interface CloudKitOptions {
  container: string
  environment?: 'development' | 'production'
  /** API token from the CloudKit Dashboard (public, identifies the app). */
  apiToken: string
  auth: CloudKitTokenSource
  fetch: FetchFn
  /** Defaults to https://api.apple-cloudkit.com; tests point it at the fake. */
  endpoint?: string
  pageSize?: number
}

export const RECORD_TYPE = 'CursusObject'
export const ASSET_THRESHOLD = 700 * 1024
export const MAX_OBJECT = 50 * 1024 * 1024
const DEFAULT_ENDPOINT = 'https://api.apple-cloudkit.com'
/** Asset download URLs end with a `${f}` placeholder for the file name. */
const FILENAME_PLACEHOLDER = `${'$'}{f}`

/** Record names are limited to 255 ASCII characters; keys are not, so the name is a hash of the key. */
export const recordNameOf = (key: Key): string => `o-${sha256Hex(new TextEncoder().encode(key))}`

interface CkError {
  serverErrorCode?: string
  reason?: string
  retryAfter?: number
}
interface CkField {
  value: unknown
  type?: string
}
interface CkRecord extends CkError {
  recordName: string
  fields?: Record<string, CkField>
}

const KIND_BY_CODE: Record<string, RemoteErrorKind> = {
  AUTHENTICATION_REQUIRED: 'auth',
  AUTHENTICATION_FAILED: 'auth',
  ACCESS_DENIED: 'permission',
  QUOTA_EXCEEDED: 'quota',
  THROTTLED: 'rate-limited',
  TRY_AGAIN_LATER: 'rate-limited',
}

const KIND_BY_STATUS: Record<number, RemoteErrorKind> = {
  401: 'auth',
  421: 'auth',
  403: 'permission',
  413: 'quota',
  429: 'rate-limited',
  503: 'rate-limited',
}

/** CloudKit error (a whole response or one record of it) → RemoteError; unknown codes are transient. */
export function cloudkitError(status: number, body: CkError, what: string): RemoteError {
  const code = body.serverErrorCode ?? ''
  const kind = KIND_BY_CODE[code] ?? KIND_BY_STATUS[status] ?? 'network'
  const m = `${what}: ${code || `HTTP ${status}`}${body.reason ? ` (${body.reason})` : ''}`
  return new RemoteError(kind, m, body.retryAfter !== undefined ? body.retryAfter * 1000 : undefined)
}

export function toBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function cloudkitRemote(o: CloudKitOptions): RemoteStore {
  const env = o.environment ?? 'production'
  const id = destinationId({ type: 'cloudkit', bucket: `${o.container}/${env}` })
  const base = `${(o.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')}/database/1/${encodeURIComponent(o.container)}/${env}/private`
  const pageSize = o.pageSize ?? 200

  async function send(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await o.fetch(url, init)
    } catch (e) {
      throw new RemoteError('network', `${what}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Signed-in POST to the database API, JSON in and out; any HTTP or server error becomes a RemoteError. */
  async function call<T>(path: string, body: unknown, what: string): Promise<T> {
    const token = await o.auth.token()
    if (!token) throw new RemoteError('auth', `${what}: not signed in to iCloud`)
    const q = `ckAPIToken=${encodeURIComponent(o.apiToken)}&ckWebAuthToken=${encodeURIComponent(token)}`
    const res = await send(
      `${base}/${path}?${q}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      what,
    )
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new RemoteError(KIND_BY_STATUS[res.status] ?? 'network', `${what}: HTTP ${res.status}, unreadable body`)
    }
    if (!res.ok) {
      const err = cloudkitError(res.status, json as CkError, what)
      if (err.kind === 'auth') await o.auth.invalidate()
      throw err
    }
    return json as T
  }

  /** Per-record error inside a successful response. */
  async function recordError(r: CkRecord, what: string): Promise<RemoteError> {
    const err = cloudkitError(200, r, what)
    if (err.kind === 'auth') await o.auth.invalidate()
    return err
  }

  async function download(url: string, what: string): Promise<Uint8Array> {
    const res = await send(url.replace(FILENAME_PLACEHOLDER, 'data'), { method: 'GET' }, what)
    if (!res.ok) throw cloudkitError(res.status, {}, what)
    return new Uint8Array(await res.arrayBuffer())
  }

  /** assets/upload hands out a URL, the bytes go there, the receipt it returns becomes the field value. */
  async function uploadAsset(recordName: string, body: Uint8Array, what: string): Promise<unknown> {
    const { tokens } = await call<{ tokens: { url: string }[] }>(
      'assets/upload',
      { tokens: [{ recordName, recordType: RECORD_TYPE, fieldName: 'asset' }] },
      what,
    )
    const url = tokens[0]?.url
    if (!url) throw new RemoteError('network', `${what}: no upload URL`)
    const res = await send(url, { method: 'POST', body: body.slice() }, what)
    let json: { singleFile?: unknown } & CkError
    try {
      json = await res.json()
    } catch {
      throw new RemoteError(KIND_BY_STATUS[res.status] ?? 'network', `${what}: HTTP ${res.status}, unreadable upload`)
    }
    if (!res.ok || !json.singleFile) throw cloudkitError(res.status, json, what)
    return json.singleFile
  }

  return {
    id,
    list(prefix, lo) {
      return {
        async *[Symbol.asyncIterator]() {
          let marker: string | undefined
          do {
            const page = await call<{ records: CkRecord[]; continuationMarker?: string }>(
              'records/query',
              {
                query: {
                  recordType: RECORD_TYPE,
                  filterBy: [{ fieldName: 'key', comparator: 'BEGINS_WITH', fieldValue: { value: prefix } }],
                  sortBy: [{ fieldName: 'key', ascending: true }],
                },
                desiredKeys: ['key', 'size'],
                resultsLimit: lo?.pageSize ?? pageSize,
                ...(marker ? { continuationMarker: marker } : {}),
              },
              `list ${prefix}`,
            )
            for (const r of page.records) {
              if (r.serverErrorCode) throw await recordError(r, `list ${prefix}`)
              const key = r.fields?.key?.value as string
              if (lo?.startAfter !== undefined && key <= lo.startAfter) continue
              yield { key, size: r.fields?.size?.value as number, handle: r.recordName } as Entry
            }
            marker = page.continuationMarker
          } while (marker)
        },
      }
    },
    async get(e) {
      const what = `get ${e.key}`
      const { records } = await call<{ records: CkRecord[] }>(
        'records/lookup',
        { records: [{ recordName: e.handle ?? recordNameOf(e.key) }] },
        what,
      )
      const r = records[0]
      if (!r || r.serverErrorCode === 'NOT_FOUND') return null
      if (r.serverErrorCode) throw await recordError(r, what)
      const f = r.fields ?? {}
      const asset = f.asset?.value as { downloadURL?: string } | undefined
      const body = asset?.downloadURL
        ? await download(asset.downloadURL, what)
        : fromBase64((f.data?.value as string | undefined) ?? '')
      // A record whose bytes do not match its hash is a broken upload, never a valid "absent".
      if (f.sha && sha256Hex(body) !== f.sha.value) throw new RemoteError('network', `${what}: checksum mismatch`)
      return body
    },
    async put(key, body) {
      const what = `put ${key}`
      if (body.length > MAX_OBJECT) throw new RemoteError('quota', `${what}: ${body.length} bytes exceeds 50 MB`)
      const recordName = recordNameOf(key)
      const fields: Record<string, CkField> = {
        key: { value: key, type: 'STRING' },
        sha: { value: sha256Hex(body), type: 'STRING' },
        size: { value: body.length, type: 'INT64' },
      }
      if (body.length > ASSET_THRESHOLD) fields.asset = { value: await uploadAsset(recordName, body, what) }
      else fields.data = { value: toBase64(body), type: 'BYTES' }
      const { records } = await call<{ records: CkRecord[] }>(
        'records/modify',
        { operations: [{ operationType: 'forceReplace', record: { recordName, recordType: RECORD_TYPE, fields } }] },
        what,
      )
      const r = records[0]
      if (!r) throw new RemoteError('network', `${what}: empty modify response`)
      if (r.serverErrorCode) throw await recordError(r, what)
    },
  }
}
