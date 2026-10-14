import { RemoteError } from '../../contracts/errors'
import type { Entry, Key, RemoteStore } from '../../contracts/remote'
import { destinationId } from '../identity'
import { type Fetch, retryAfterMs, type TokenSource } from './gdriveAuth'

/**
 * RemoteStore over Google Drive v3 (scope drive.file). Every key is one file named after the full key, flat in a
 * visible root folder tagged `appProperties.cursusRoot=1`. Two devices can create a root at the same time: every
 * tagged root of that name is listed (union) and writes go to the smallest id, the same pick on every device.
 * Drive allows several files with the same name: concurrent creations both survive and are listed as duplicates,
 * each with its own handle (the file id). Listings are eventually consistent, so ids of our own writes are
 * remembered; creations use ids from `files.generateIds`, which makes a retried create idempotent (409 = done).
 */

export const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
/** Above this size, uploads go through a resumable session instead of one multipart request. */
export const MULTIPART_MAX = 5 * 1024 * 1024

export interface GDriveOptions {
  fetch: Fetch
  tokens: TokenSource
  /** Name of the visible root folder in "My Drive" (created on first use). */
  rootName: string
  /** Default page size for files.list (Drive caps it at 1000). */
  pageSize?: number
}

interface DriveFile {
  id: string
  name: string
  size?: string
  createdTime?: string
}

interface DriveList {
  files?: DriveFile[]
  nextPageToken?: string
}

/** Literal for a Drive query string. */
function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'])
const QUOTA_REASONS = new Set(['storageQuotaExceeded', 'quotaExceeded', 'teamDriveFileLimitExceeded'])

/** Drive HTTP failure → RemoteError kind. */
async function driveError(res: Response, what: string): Promise<RemoteError> {
  let reason = ''
  let message = ''
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } }
    reason = body.error?.errors?.[0]?.reason ?? ''
    message = body.error?.message ?? ''
  } catch {
    // Not JSON (proxy page, empty body): the status alone decides.
  }
  const m = `${what}: ${res.status} ${reason} ${message}`.trim()
  if (res.status === 401) return new RemoteError('auth', m)
  if (res.status === 429 || RATE_REASONS.has(reason)) return new RemoteError('rate-limited', m, retryAfterMs(res))
  if (QUOTA_REASONS.has(reason)) return new RemoteError('quota', m)
  if (res.status === 403 || res.status === 404) return new RemoteError('permission', m)
  return new RemoteError('network', m)
}

interface Call {
  method: string
  headers?: Record<string, string>
  body?: BodyInit
  /** Statuses returned to the caller instead of thrown (404 on a get, 409 on a create). */
  pass?: number[]
}

/** Authorized request; a 401 refreshes the token once, a second 401 means consent is needed. */
async function call(o: { fetch: Fetch; tokens: TokenSource }, url: string, c: Call, what: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = await o.tokens.token()
    let res: Response
    try {
      res = await o.fetch(url, {
        method: c.method,
        headers: { ...c.headers, authorization: `Bearer ${token}` },
        body: c.body,
      })
    } catch (e) {
      throw new RemoteError('network', `${what}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (res.ok || c.pass?.includes(res.status)) return res
    if (res.status === 401 && attempt === 0) {
      await o.tokens.invalidate()
      continue
    }
    throw await driveError(res, what)
  }
}

const enc = new TextEncoder()

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

/** multipart/related body (metadata + media): one request, no half-created file on failure. */
export function multipart(metadata: object, body: Uint8Array): { boundary: string; bytes: Uint8Array<ArrayBuffer> } {
  let boundary = 'cursus-gdrive-7f3c9e2a'
  for (let n = 0; contains(body, enc.encode(boundary)); n++) boundary = `cursus-gdrive-7f3c9e2a-${n}`
  const head = enc.encode(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
  )
  const tail = enc.encode(`\r\n--${boundary}--`)
  const bytes = new Uint8Array(head.length + body.length + tail.length)
  bytes.set(head, 0)
  bytes.set(body, head.length)
  bytes.set(tail, head.length + body.length)
  return { boundary, bytes }
}

const byName = (a: DriveFile, b: DriveFile): number =>
  a.name !== b.name
    ? a.name < b.name
      ? -1
      : 1
    : (a.createdTime ?? '').localeCompare(b.createdTime ?? '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export interface GDriveRemote extends RemoteStore {
  /** Ids of every tagged root folder, smallest (the write root) first. */
  roots(): Promise<string[]>
}

export function gdriveRemote(o: GDriveOptions): GDriveRemote {
  const id = destinationId({ type: 'gdrive', bucket: o.rootName })
  /** Key → id of a file this instance created (or is creating): found even before Drive lists it. */
  const known = new Map<Key, string>()
  let rootCache: string[] | null = null
  let spareIds: string[] = []

  async function json<T>(url: string, c: Call, what: string): Promise<T> {
    return (await (await call(o, url, c, what)).json()) as T
  }

  async function generateId(): Promise<string> {
    if (spareIds.length === 0) {
      const r = await json<{ ids?: string[] }>(
        `${DRIVE_API}/files/generateIds?count=10&space=drive&type=files`,
        { method: 'GET' },
        'Drive generateIds',
      )
      spareIds = [...(r.ids ?? [])]
      if (spareIds.length === 0) throw new RemoteError('network', 'Drive generateIds returned no id')
    }
    return spareIds.shift() as string
  }

  async function* pages(q: string, pageSize: number, orderBy: string): AsyncGenerator<DriveFile[]> {
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        q,
        orderBy,
        pageSize: String(pageSize),
        fields: 'nextPageToken,files(id,name,size,createdTime)',
        spaces: 'drive',
      })
      if (pageToken) params.set('pageToken', pageToken)
      const page = await json<DriveList>(`${DRIVE_API}/files?${params}`, { method: 'GET' }, 'Drive list')
      yield page.files ?? []
      pageToken = page.nextPageToken
    } while (pageToken)
  }

  /** Every tagged root of that name; creates one (idempotently) when there is none yet. */
  async function lookupRoots(create: boolean): Promise<string[]> {
    const q =
      `name = ${quote(o.rootName)} and mimeType = ${quote(FOLDER_MIME)} and trashed = false and ` +
      `appProperties has { key='cursusRoot' and value='1' }`
    const found: string[] = []
    for await (const files of pages(q, 100, 'createdTime')) for (const f of files) found.push(f.id)
    if (rootCache) for (const r of rootCache) if (!found.includes(r)) found.push(r) // ours, not listed yet
    if (found.length === 0 && create) {
      const rootId = await generateId()
      await call(
        o,
        `${DRIVE_API}/files?fields=id`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: rootId,
            name: o.rootName,
            mimeType: FOLDER_MIME,
            appProperties: { cursusRoot: '1' },
          }),
          pass: [409],
        },
        'Drive root creation',
      )
      found.push(rootId)
    }
    found.sort()
    if (found.length > 0) rootCache = found
    return found
  }

  const inRoots = (roots: string[]): string =>
    `(${roots.map((r) => `${quote(r)} in parents`).join(' or ')}) and trashed = false`

  /** Oldest file named `key` in any root: the same pick on every device when duplicates exist. */
  async function find(key: Key): Promise<string | undefined> {
    const mine = known.get(key)
    if (mine) return mine
    const roots = rootCache ?? (await lookupRoots(false))
    if (roots.length === 0) return undefined
    for await (const files of pages(`name = ${quote(key)} and ${inRoots(roots)}`, 1, 'createdTime')) {
      const first = files[0]
      if (first) return first.id
    }
    return undefined
  }

  async function upload(fileId: string, key: Key, body: Uint8Array, create: string | null): Promise<boolean> {
    const what = `Drive ${create ? 'create' : 'update'} ${key}`
    const base = create ? `${DRIVE_UPLOAD}/files` : `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}`
    const method = create ? 'POST' : 'PATCH'
    const metadata = create ? { id: fileId, name: key, parents: [create] } : {}
    // 409 on create: a previous attempt with this generated id already landed. 404 on update: file gone.
    const pass = create ? [409] : [404]
    if (body.length <= MULTIPART_MAX) {
      const { boundary, bytes } = multipart(metadata, body)
      const res = await call(
        o,
        `${base}?uploadType=multipart&fields=id`,
        { method, headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: bytes, pass },
        what,
      )
      return res.status !== 404
    }
    const session = await call(
      o,
      `${base}?uploadType=resumable&fields=id`,
      {
        method,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': 'application/octet-stream',
          'x-upload-content-length': String(body.length),
        },
        body: JSON.stringify(metadata),
        pass,
      },
      what,
    )
    if (session.status === 404) return false
    if (session.status === 409) return true
    const location = session.headers.get('location')
    if (!location) throw new RemoteError('network', `${what}: no resumable session URL`)
    await call(
      o,
      location,
      { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(body) },
      what,
    )
    return true
  }

  return {
    id,
    roots: () => lookupRoots(false),
    list(prefix, lo) {
      const pageSize = Math.min(1000, Math.max(1, lo?.pageSize ?? o.pageSize ?? 1000))
      return {
        async *[Symbol.asyncIterator]() {
          const roots = await lookupRoots(false)
          if (roots.length === 0) return
          let q = inRoots(roots)
          if (lo?.createdAfter !== undefined)
            q += ` and createdTime > ${quote(new Date(lo.createdAfter).toISOString())}`
          // Drive's name order is not byte order (case folding, collation): gather, then sort ourselves.
          const out: DriveFile[] = []
          for await (const files of pages(q, pageSize, 'name')) {
            for (const f of files) {
              if (!f.name.startsWith(prefix)) continue
              if (lo?.startAfter !== undefined && f.name <= lo.startAfter) continue
              out.push(f)
            }
          }
          out.sort(byName)
          for (const f of out) {
            const e: Entry = { key: f.name, handle: f.id }
            if (f.size !== undefined) e.size = Number(f.size)
            yield e
          }
        },
      }
    },
    async get(e) {
      const fileId = e.handle ?? (await find(e.key))
      if (fileId === undefined) return null
      const res = await call(
        o,
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
        { method: 'GET', pass: [404] },
        `Drive get ${e.key}`,
      )
      if (res.status === 404) {
        if (known.get(e.key) === fileId) known.delete(e.key)
        return null
      }
      return new Uint8Array(await res.arrayBuffer())
    },
    async put(key, body) {
      const existing = await find(key)
      if (existing !== undefined) {
        if (await upload(existing, key, body, null)) return
        known.delete(key) // deleted behind our back: create it again
      }
      const roots = await lookupRoots(true)
      const fileId = await generateId()
      // Remembered before the request: a retry after a lost response reuses the id and gets a 409.
      known.set(key, fileId)
      await upload(fileId, key, body, roots[0] as string)
    },
  }
}
