import type { Clock } from '../../src/core/contracts/ports'
import { pkceChallenge } from '../../src/core/sync/providers/gdriveAuth'

/**
 * In-memory Google (OAuth token endpoint + the slice of Drive v3 the provider uses), served as an injected fetch.
 * Behaves like the real thing where it hurts: duplicates by name, listings that lag behind writes,
 * pageToken pagination, expiring access tokens, revocable refresh tokens, injected 401/403/429.
 */

interface FakeFile {
  id: string
  name: string
  parents: string[]
  mimeType: string
  appProperties: Record<string, string>
  bytes: Uint8Array
  created: number
}

interface PendingCode {
  challenge: string
  redirectUri: string
  clientId: string
}

export interface Fault {
  status: number
  reason?: string
  retryAfter?: number
  /** Only requests whose URL contains this. */
  match?: string
}

const dec = new TextDecoder()
const enc = new TextEncoder()

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function driveErr(status: number, reason: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code: status, message: reason, errors: [{ reason }] } }, headers)
}

function unquote(s: string): string {
  return s.replace(/\\(.)/g, '$1')
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

async function bodyBytes(init?: RequestInit): Promise<Uint8Array> {
  const b = init?.body
  if (b === undefined || b === null) return new Uint8Array()
  if (typeof b === 'string') return enc.encode(b)
  if (b instanceof Uint8Array) return b
  return new Uint8Array(await new Response(b).arrayBuffer())
}

/** Splits a multipart/related body into its metadata JSON and media bytes. */
function parseMultipart(body: Uint8Array, contentType: string): { meta: Record<string, unknown>; media: Uint8Array } {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]
  if (!boundary) throw new Error('fake Google: multipart without boundary')
  const sep = enc.encode(`--${boundary}`)
  const crlf2 = enc.encode('\r\n\r\n')
  const p1 = indexOf(body, sep)
  const h1 = indexOf(body, crlf2, p1)
  const p2 = indexOf(body, sep, h1)
  const meta = JSON.parse(dec.decode(body.slice(h1 + 4, p2 - 2))) as Record<string, unknown>
  const h2 = indexOf(body, crlf2, p2)
  const end = indexOf(body, enc.encode(`\r\n--${boundary}--`), h2)
  return { meta, media: body.slice(h2 + 4, end) }
}

export interface FakeGoogleOptions {
  clock: Clock
  clientId?: string
  /** When set, the token endpoint requires it (Google does for non-web clients). */
  clientSecret?: string
  /** A new file shows in files.list only this long after its creation. */
  listDelayMs?: number
  /** Access token lifetime, in seconds. */
  tokenTtlS?: number
}

export class FakeGoogle {
  readonly files = new Map<string, FakeFile>()
  readonly calls: { method: string; url: string }[] = []
  readonly faults: Fault[] = []
  offline = false
  listDelayMs: number
  private readonly codes = new Map<string, PendingCode>()
  private readonly refreshTokens = new Set<string>()
  private readonly accessTokens = new Map<string, number>()
  private readonly sessions = new Map<string, { create: boolean; meta: Record<string, unknown>; fileId: string }>()
  private next = 1
  readonly clientId: string

  constructor(private readonly o: FakeGoogleOptions) {
    this.clientId = o.clientId ?? 'client-1.apps.googleusercontent.com'
    this.listDelayMs = o.listDelayMs ?? 0
  }

  private newId(prefix: string): string {
    return `${prefix}${String(this.next++).padStart(8, '0')}`
  }

  /** What Google does when the user consents: a code bound to the PKCE challenge. */
  consent(o: { challenge: string; redirectUri: string; clientId?: string }): string {
    const code = this.newId('code-')
    this.codes.set(code, { challenge: o.challenge, redirectUri: o.redirectUri, clientId: o.clientId ?? this.clientId })
    return code
  }

  /** A refresh token as if consent already happened. */
  grant(): string {
    const t = this.newId('refresh-')
    this.refreshTokens.add(t)
    return t
  }

  revokeAll(): void {
    this.refreshTokens.clear()
    this.accessTokens.clear()
  }

  expireAccessTokens(): void {
    this.accessTokens.clear()
  }

  fail(f: Fault): void {
    this.faults.push(f)
  }

  /** Adds a file as another device would (bypasses auth): duplicates by name are allowed. */
  addFile(f: {
    name: string
    parents: string[]
    bytes?: Uint8Array
    mimeType?: string
    appProperties?: Record<string, string>
  }): string {
    const id = this.newId('f')
    this.files.set(id, {
      id,
      name: f.name,
      parents: f.parents,
      mimeType: f.mimeType ?? 'application/octet-stream',
      appProperties: f.appProperties ?? {},
      bytes: (f.bytes ?? new Uint8Array()).slice(),
      created: this.o.clock.now(),
    })
    return id
  }

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    this.calls.push({ method, url: input })
    if (this.offline) throw new TypeError('Failed to fetch')
    const fi = this.faults.findIndex((f) => f.match === undefined || input.includes(f.match))
    if (fi >= 0) {
      const f = this.faults.splice(fi, 1)[0] as Fault
      const headers: Record<string, string> = f.retryAfter === undefined ? {} : { 'retry-after': String(f.retryAfter) }
      if (input.startsWith('https://oauth2.googleapis.com/token'))
        return json(f.status, { error: f.reason ?? 'server_error' }, headers)
      return f.reason === 'no-json'
        ? new Response('<html>oops</html>', { status: f.status, headers })
        : driveErr(f.status, f.reason ?? 'error', headers)
    }
    const url = new URL(input)
    if (url.host === 'oauth2.googleapis.com') return this.token(await bodyBytes(init))
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const exp = this.accessTokens.get(auth.replace(/^Bearer /, ''))
    if (exp === undefined || exp <= this.o.clock.now()) return driveErr(401, 'authError')
    return this.drive(method, url, init)
  }

  private token(raw: Uint8Array): Response {
    const p = new URLSearchParams(dec.decode(raw))
    if (p.get('client_id') !== this.clientId) return json(401, { error: 'invalid_client' })
    if (this.o.clientSecret !== undefined && p.get('client_secret') !== this.o.clientSecret)
      return json(400, { error: 'invalid_request', error_description: 'client_secret is missing.' })
    let refresh: string | undefined
    if (p.get('grant_type') === 'authorization_code') {
      const c = this.codes.get(p.get('code') ?? '')
      this.codes.delete(p.get('code') ?? '')
      if (!c || c.redirectUri !== p.get('redirect_uri') || pkceChallenge(p.get('code_verifier') ?? '') !== c.challenge)
        return json(400, { error: 'invalid_grant', error_description: 'Bad Request' })
      refresh = this.grant()
    } else if (p.get('grant_type') === 'refresh_token') {
      if (!this.refreshTokens.has(p.get('refresh_token') ?? ''))
        return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
    } else return json(400, { error: 'unsupported_grant_type' })
    const access = this.newId('access-')
    const ttl = this.o.tokenTtlS ?? 3600
    this.accessTokens.set(access, this.o.clock.now() + ttl * 1000)
    return json(200, {
      access_token: access,
      expires_in: ttl,
      token_type: 'Bearer',
      ...(refresh ? { refresh_token: refresh } : {}),
    })
  }

  private meta(f: FakeFile): Record<string, string> {
    return { id: f.id, name: f.name, size: String(f.bytes.length), createdTime: new Date(f.created).toISOString() }
  }

  private matches(f: FakeFile, q: string): boolean {
    let rest = q
    const name = /name = '((?:\\.|[^'\\])*)'/.exec(rest)
    if (name) {
      if (f.name !== unquote(name[1] as string)) return false
      rest = rest.replace(name[0], '')
    }
    const parents = [...rest.matchAll(/'([^']+)' in parents/g)].map((m) => m[1] as string)
    if (parents.length > 0 && !parents.some((p) => f.parents.includes(p))) return false
    const mime = /mimeType = '([^']+)'/.exec(rest)
    if (mime && f.mimeType !== mime[1]) return false
    const prop = /appProperties has \{ key='(\w+)' and value='(\w+)' \}/.exec(rest)
    if (prop && f.appProperties[prop[1] as string] !== prop[2]) return false
    const after = /createdTime > '([^']+)'/.exec(rest)
    if (after && !(f.created > Date.parse(after[1] as string))) return false
    return true
  }

  private async drive(method: string, url: URL, init?: RequestInit): Promise<Response> {
    const path = url.pathname
    const now = this.o.clock.now()
    if (method === 'GET' && path === '/drive/v3/files/generateIds') {
      const n = Number(url.searchParams.get('count') ?? '10')
      return json(200, { ids: Array.from({ length: n }, () => this.newId('g')) })
    }
    if (method === 'GET' && path === '/drive/v3/files') {
      const q = url.searchParams.get('q') ?? ''
      const orderBy = url.searchParams.get('orderBy') ?? 'name'
      const pageSize = Number(url.searchParams.get('pageSize') ?? '100')
      const start = Number(url.searchParams.get('pageToken') ?? '0')
      const all = [...this.files.values()]
        .filter((f) => f.created + this.listDelayMs <= now && this.matches(f, q))
        // Drive's own order folds case: the provider must not rely on it.
        .sort((a, b) =>
          orderBy === 'createdTime'
            ? a.created - b.created || a.id.localeCompare(b.id)
            : a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id),
        )
      const page = all.slice(start, start + pageSize)
      const nextPageToken = start + pageSize < all.length ? String(start + pageSize) : undefined
      return json(200, { files: page.map((f) => this.meta(f)), ...(nextPageToken ? { nextPageToken } : {}) })
    }
    if (method === 'POST' && path === '/drive/v3/files') {
      const meta = JSON.parse(dec.decode(await bodyBytes(init))) as Record<string, unknown>
      return this.create(meta, new Uint8Array())
    }
    const fileMatch = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path)
    if (method === 'GET' && fileMatch && url.searchParams.get('alt') === 'media') {
      const f = this.files.get(decodeURIComponent(fileMatch[1] as string))
      if (!f) return driveErr(404, 'notFound')
      return new Response(f.bytes.slice(), { status: 200 })
    }
    const uploadType = url.searchParams.get('uploadType')
    const contentType = new Headers(init?.headers).get('content-type') ?? ''
    if (path === '/upload/drive/v3/files' && method === 'POST') {
      if (uploadType === 'multipart') {
        const { meta, media } = parseMultipart(await bodyBytes(init), contentType)
        return this.create(meta, media)
      }
      if (uploadType === 'resumable') {
        const meta = JSON.parse(dec.decode(await bodyBytes(init))) as Record<string, unknown>
        if (typeof meta.id === 'string' && this.files.has(meta.id)) return driveErr(409, 'fileIdInUse')
        return this.session(true, meta, String(meta.id ?? ''))
      }
    }
    if (fileMatch && method === 'PATCH' && path.startsWith('/upload/')) {
      const id = decodeURIComponent(fileMatch[1] as string)
      const f = this.files.get(id)
      if (!f) return driveErr(404, 'notFound')
      if (uploadType === 'multipart') {
        f.bytes = parseMultipart(await bodyBytes(init), contentType).media.slice()
        return json(200, { id })
      }
      if (uploadType === 'media') {
        f.bytes = (await bodyBytes(init)).slice()
        return json(200, { id })
      }
      if (uploadType === 'resumable') return this.session(false, {}, id)
    }
    if (method === 'PUT' && path === '/upload/drive/v3/session') {
      const s = this.sessions.get(url.searchParams.get('upload_id') ?? '')
      if (!s) return driveErr(404, 'notFound')
      const media = await bodyBytes(init)
      this.sessions.delete(url.searchParams.get('upload_id') ?? '')
      if (s.create) return this.create(s.meta, media)
      const f = this.files.get(s.fileId)
      if (!f) return driveErr(404, 'notFound')
      f.bytes = media.slice()
      return json(200, { id: f.id })
    }
    return driveErr(400, `unsupported ${method} ${path}`)
  }

  private session(create: boolean, meta: Record<string, unknown>, fileId: string): Response {
    const uploadId = this.newId('up')
    this.sessions.set(uploadId, { create, meta, fileId })
    return new Response(null, {
      status: 200,
      headers: { location: `https://www.googleapis.com/upload/drive/v3/session?upload_id=${uploadId}` },
    })
  }

  private create(meta: Record<string, unknown>, media: Uint8Array): Response {
    const id = typeof meta.id === 'string' ? meta.id : this.newId('f')
    if (this.files.has(id)) return driveErr(409, 'fileIdInUse')
    this.files.set(id, {
      id,
      name: String(meta.name ?? 'Untitled'),
      parents: Array.isArray(meta.parents) ? (meta.parents as string[]) : ['root'],
      mimeType: String(meta.mimeType ?? 'application/octet-stream'),
      appProperties: (meta.appProperties as Record<string, string>) ?? {},
      bytes: media.slice(),
      created: this.o.clock.now(),
    })
    return json(200, { id })
  }
}
