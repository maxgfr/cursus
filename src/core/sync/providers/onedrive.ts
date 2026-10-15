import type { Entry, Key, RemoteStore } from '../../contracts/remote'
import { RemoteError } from '../../contracts/remote'
import { destinationId, normalizePrefix } from '../identity'
import type { Fetch, TokenSource } from './onedriveAuth'

/**
 * OneDrive through Microsoft Graph, in the app folder (`/me/drive/special/approot`, « Apps/Cursus »): the
 * app sees nothing else. Keys are paths (`seg/dev/…` becomes folders); Graph creates the parent folders on
 * upload. A path holds one item, so there are no duplicates.
 */
export const GRAPH = 'https://graph.microsoft.com/v1.0'
/** Simple upload limit; larger bodies go through an upload session. */
export const ONEDRIVE_UPLOAD_LIMIT = 4 * 1024 * 1024
/** Upload session fragments must be multiples of 320 KiB. */
export const FRAGMENT = 320 * 1024

export interface OneDriveRemoteOptions {
  fetch: Fetch
  tokens: TokenSource
  /** Folder inside the app folder; empty = the app folder itself. */
  root?: string
  graphBase?: string
  uploadLimit?: number
  /** Upload session fragment size (a multiple of 320 KiB against the real service). */
  chunkSize?: number
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
}

interface Item {
  id: string
  name: string
  size?: number
  folder?: unknown
  file?: unknown
}

interface Page {
  value: Item[]
  '@odata.nextLink'?: string
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/')

interface CallInit {
  method: string
  headers?: Record<string, string>
  body?: BodyInit
  /** Upload session URLs are pre-authorized: no bearer token goes there. */
  auth?: boolean
  allowNotFound?: boolean
}

export function onedriveRemote(o: OneDriveRemoteOptions): RemoteStore {
  const root = normalizePrefix(o.root)
  const graph = o.graphBase ?? GRAPH
  const uploadLimit = o.uploadLimit ?? ONEDRIVE_UPLOAD_LIMIT
  const chunkSize = o.chunkSize ?? 10 * FRAGMENT
  const maxRetries = o.maxRetries ?? 5
  const sleep = o.sleep ?? defaultSleep
  const id = destinationId({ type: 'onedrive', prefix: root })
  const approot = `${graph}/me/drive/special/approot`

  /** A path below the app folder, as Graph's `approot:/<path>:` addressing. */
  const byPath = (rel: string, suffix: string): string => {
    const full = root ? (rel ? `${root}/${rel}` : root) : rel
    return full ? `${approot}:/${encodePath(full)}:${suffix}` : `${approot}${suffix}`
  }

  /** One call with refresh on 401 and backoff on 429/5xx. Null on a 404 when `allowNotFound`. */
  async function call(url: string, init: CallInit): Promise<Response | null> {
    let refreshed = false
    const auth = init.auth ?? true
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { ...init.headers }
      if (auth) headers.Authorization = `Bearer ${await o.tokens.token()}`
      let res: Response
      try {
        res = await o.fetch(url, {
          method: init.method,
          headers,
          ...(init.body !== undefined ? { body: init.body } : {}),
        })
      } catch (e) {
        throw new RemoteError('network', `OneDrive request failed: ${String(e)}`)
      }
      if (res.ok) return res
      const text = await res.text()
      if (res.status === 401 && auth && !refreshed) {
        refreshed = true
        await o.tokens.refresh()
        continue
      }
      if (res.status === 507) throw new RemoteError('quota', `OneDrive storage full: ${text}`)
      if (res.status === 429 || res.status >= 500) {
        const header = Number(res.headers.get('Retry-After'))
        const wait = Number.isFinite(header) && header > 0 ? header * 1000 : Math.min(30_000, 500 * 2 ** attempt)
        if (attempt < maxRetries) {
          await sleep(wait)
          continue
        }
        if (res.status === 429) throw new RemoteError('rate-limited', `OneDrive rate limit: ${text}`, wait)
        throw new RemoteError('network', `OneDrive ${res.status}: ${text}`)
      }
      if (res.status === 404 && init.allowNotFound) return null
      throw mapError(res.status, text)
    }
  }

  /** Every file under a folder (recursive, following `@odata.nextLink`), keyed by its path below the root. */
  async function walk(
    first: string,
    rel: string,
    prefix: string,
    pageSize: number | undefined,
    out: Entry[],
  ): Promise<void> {
    const top = pageSize ? `?$top=${Math.min(999, pageSize)}` : ''
    let url: string | undefined = `${first}${top}`
    while (url) {
      const res = await call(url, { method: 'GET', allowNotFound: true })
      // A folder that is not there (yet, or any more) holds nothing.
      if (!res) return
      const page = (await res.json()) as Page
      for (const item of page.value) {
        const key = rel ? `${rel}/${item.name}` : item.name
        if (item.folder !== undefined) {
          const dir = `${key}/`
          if (dir.startsWith(prefix) || prefix.startsWith(dir))
            await walk(`${graph}/me/drive/items/${encodeURIComponent(item.id)}/children`, key, prefix, pageSize, out)
        } else if (key.startsWith(prefix)) {
          out.push({ key, ...(item.size !== undefined ? { size: item.size } : {}), handle: item.id })
        }
      }
      url = page['@odata.nextLink']
    }
  }

  async function putLarge(key: Key, body: Uint8Array): Promise<void> {
    const session = await call(byPath(key, '/createUploadSession'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    })
    const { uploadUrl } = (await (session as Response).json()) as { uploadUrl: string }
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      const chunk = body.subarray(offset, offset + chunkSize)
      await call(uploadUrl, {
        method: 'PUT',
        auth: false,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${offset}-${offset + chunk.length - 1}/${body.length}`,
        },
        body: chunk as BodyInit,
      })
    }
  }

  return {
    id,
    list(prefix, lo) {
      return {
        async *[Symbol.asyncIterator]() {
          const slash = prefix.lastIndexOf('/')
          const dir = slash < 0 ? '' : prefix.slice(0, slash)
          const entries: Entry[] = []
          // Graph has no time filter on a listing: every key is returned, a superset of `createdAfter`.
          await walk(byPath(dir, '/children'), dir, prefix, lo?.pageSize, entries)
          const after = lo?.startAfter
          const kept = after === undefined ? entries : entries.filter((e) => e.key > after)
          kept.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          yield* kept
        },
      }
    },
    async get(e) {
      const url = e.handle
        ? `${graph}/me/drive/items/${encodeURIComponent(e.handle)}/content`
        : byPath(e.key, '/content')
      const res = await call(url, { method: 'GET', allowNotFound: true })
      return res ? new Uint8Array(await res.arrayBuffer()) : null
    },
    async put(key, body) {
      if (body.length > uploadLimit) return putLarge(key, body)
      await call(byPath(key, '/content?@microsoft.graph.conflictBehavior=replace'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: body as BodyInit,
      })
    },
  }
}

function mapError(status: number, text: string): RemoteError {
  if (status === 401) return new RemoteError('auth', `OneDrive auth: ${text}`)
  if (/quotaLimitReached|insufficientStorage/.test(text)) return new RemoteError('quota', `OneDrive: ${text}`)
  return new RemoteError('permission', `OneDrive ${status}: ${text}`)
}
