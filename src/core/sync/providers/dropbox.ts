import type { Clock } from '../../contracts/ports'
import type { Entry, Key, RemoteStore } from '../../contracts/remote'
import { RemoteError } from '../../contracts/remote'
import { destinationId, normalizePrefix } from '../identity'
import type { Fetch, TokenSource } from './dropboxAuth'

export const DROPBOX_API = 'https://api.dropboxapi.com'
export const DROPBOX_CONTENT = 'https://content.dropboxapi.com'
/** Single-request upload limit; larger bodies go through an upload session. */
export const UPLOAD_LIMIT = 150 * 1024 * 1024

export interface DropboxRemoteOptions {
  fetch: Fetch
  tokens: TokenSource
  clock: Clock
  /** Folder inside the app folder (`Apps/Cursus`); empty = the app folder itself. */
  root?: string
  /** Account id, part of the destination identity. */
  account?: string
  apiBase?: string
  contentBase?: string
  uploadLimit?: number
  chunkSize?: number
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
}

export interface DropboxRemote extends RemoteStore {
  /** Cursors kept per listed folder, for incremental listings (exposed for tests). */
  readonly cursors: Map<string, { cursor: string; at: number }>
}

interface Meta {
  '.tag': string
  id?: string
  path_display?: string
  path_lower?: string
  size?: number
  server_modified?: string
}

/** HTTP headers must be ASCII: Dropbox wants non-ASCII characters of Dropbox-API-Arg as \uXXXX escapes. */
export function apiArg(arg: unknown): string {
  return JSON.stringify(arg).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function dropboxRemote(o: DropboxRemoteOptions): DropboxRemote {
  const root = normalizePrefix(o.root)
  const base = root ? `/${root}` : ''
  const api = o.apiBase ?? DROPBOX_API
  const content = o.contentBase ?? DROPBOX_CONTENT
  const uploadLimit = o.uploadLimit ?? UPLOAD_LIMIT
  const chunkSize = o.chunkSize ?? 8 * 1024 * 1024
  const maxRetries = o.maxRetries ?? 5
  const sleep = o.sleep ?? defaultSleep
  const cursors = new Map<string, { cursor: string; at: number }>()
  const id = destinationId({ type: 'dropbox', bucket: o.account, prefix: root })

  /** One call with auth refresh on 401 and backoff on 429/5xx. Returns null on a 409 path/not_found. */
  async function call(
    url: string,
    init: { headers: Record<string, string>; body?: BodyInit },
    allowNotFound = false,
  ): Promise<Response | null> {
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      const token = await o.tokens.token()
      let res: Response
      try {
        res = await o.fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, ...init.headers },
          body: init.body,
        })
      } catch (e) {
        throw new RemoteError('network', `Dropbox request failed: ${String(e)}`)
      }
      if (res.ok) return res
      const text = await res.text()
      if (res.status === 401 && !refreshed) {
        refreshed = true
        await o.tokens.refresh()
        continue
      }
      if (res.status === 429 || res.status >= 500) {
        const header = Number(res.headers.get('Retry-After'))
        const wait = Number.isFinite(header) && header > 0 ? header * 1000 : Math.min(30_000, 500 * 2 ** attempt)
        if (attempt < maxRetries) {
          await sleep(wait)
          continue
        }
        if (res.status === 429) throw new RemoteError('rate-limited', `Dropbox rate limit: ${text}`, wait)
        throw new RemoteError('network', `Dropbox ${res.status}: ${text}`)
      }
      if (res.status === 409 && allowNotFound && /(^|\/)not_found\b/.test(summary(text))) return null
      throw mapError(res.status, text)
    }
  }

  async function rpc<T>(path: string, arg: unknown, allowNotFound = false): Promise<T | null> {
    const res = await call(
      `${api}/2/${path}`,
      { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(arg) },
      allowNotFound,
    )
    return res ? ((await res.json()) as T) : null
  }

  async function upload<T>(path: string, arg: unknown, body: Uint8Array): Promise<T> {
    const res = await call(`${content}/2/${path}`, {
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': apiArg(arg) },
      body: body as BodyInit,
    })
    return (await (res as Response).json()) as T
  }

  const pathOf = (key: Key) => `${base}/${key}`

  /** Every file under `dir` (recursive), following list_folder/continue; keeps the final cursor. */
  async function listDir(dir: string, pageSize?: number, from?: string): Promise<Meta[]> {
    type Page = { entries: Meta[]; cursor: string; has_more: boolean }
    const out: Meta[] = []
    let page: Page | null
    if (from) page = await rpc<Page>('files/list_folder/continue', { cursor: from })
    else
      page = await rpc<Page>(
        'files/list_folder',
        { path: dir, recursive: true, ...(pageSize ? { limit: Math.min(2000, pageSize) } : {}) },
        true,
      )
    if (!page) return out
    for (;;) {
      out.push(...page.entries)
      if (!page.has_more) break
      page = (await rpc<Page>('files/list_folder/continue', { cursor: page.cursor })) as Page
    }
    cursors.set(dir, { cursor: page.cursor, at: o.clock.now() })
    return out
  }

  return {
    id,
    cursors,
    list(prefix, lo) {
      return {
        async *[Symbol.asyncIterator]() {
          const slash = prefix.lastIndexOf('/')
          const dir = slash < 0 ? base : `${base}/${prefix.slice(0, slash)}`
          const createdAfter = lo?.createdAfter
          const saved = cursors.get(dir)
          // A cursor taken before `createdAfter` lists every change since then: native incremental listing.
          const incremental = createdAfter !== undefined && saved !== undefined && saved.at <= createdAfter
          const metas = await listDir(dir, lo?.pageSize, incremental ? saved.cursor : undefined)
          const entries: Entry[] = []
          const strip = base.length + 1
          for (const m of metas) {
            if (m['.tag'] !== 'file' || !m.path_display) continue
            const key = m.path_display.slice(strip)
            if (!key.startsWith(prefix)) continue
            if (lo?.startAfter !== undefined && key <= lo.startAfter) continue
            if (!incremental && createdAfter !== undefined && Date.parse(m.server_modified ?? '') < createdAfter)
              continue
            entries.push({ key, size: m.size, handle: m.id })
          }
          entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          yield* entries
        },
      }
    },
    async get(e) {
      const res = await call(
        `${content}/2/files/download`,
        { headers: { 'Dropbox-API-Arg': apiArg({ path: e.handle ?? pathOf(e.key) }) } },
        true,
      )
      return res ? new Uint8Array(await res.arrayBuffer()) : null
    },
    async put(key, body) {
      const commit = { path: pathOf(key), mode: 'overwrite', autorename: false, mute: true }
      if (body.length <= uploadLimit) {
        await upload('files/upload', commit, body)
        return
      }
      const first = body.subarray(0, chunkSize)
      const { session_id } = await upload<{ session_id: string }>('files/upload_session/start', { close: false }, first)
      let offset = first.length
      while (body.length - offset > chunkSize) {
        const chunk = body.subarray(offset, offset + chunkSize)
        await upload('files/upload_session/append_v2', { cursor: { session_id, offset }, close: false }, chunk)
        offset += chunk.length
      }
      await upload('files/upload_session/finish', { cursor: { session_id, offset }, commit }, body.subarray(offset))
    },
  }
}

function summary(text: string): string {
  try {
    return String((JSON.parse(text) as { error_summary?: string }).error_summary ?? '')
  } catch {
    return text
  }
}

function mapError(status: number, text: string): RemoteError {
  const s = summary(text)
  if (status === 401) return new RemoteError('auth', `Dropbox auth: ${s}`)
  if (status === 403) return new RemoteError('permission', `Dropbox: ${s}`)
  if (status === 409 && /insufficient_space/.test(s)) return new RemoteError('quota', `Dropbox: ${s}`)
  return new RemoteError('permission', `Dropbox ${status}: ${s}`)
}
