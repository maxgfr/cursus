import type { VirtualClock } from '../../src/core/ports/clock'

/**
 * In-memory Dropbox API (app folder) speaking HTTP: the OAuth token endpoint, list_folder(+continue),
 * download, upload and upload sessions. Use `handle` as an injected fetch, or `serve()` behind Bun.serve.
 * Paths are case-insensitive and case-preserving, like Dropbox.
 */
interface FileRec {
  id: string
  path: string
  bytes: Uint8Array
  modified: number
  seq: number
}

interface CursorState {
  dir: string
  /** Snapshot listing in progress: remaining lower paths. */
  pending?: string[]
  /** Changes mode: everything with seq > this. */
  seq: number
  limit: number
}

export class FakeDropbox {
  readonly files = new Map<string, FileRec>()
  readonly calls: string[] = []
  readonly refreshes: string[] = []
  readonly argHeaders: string[] = []
  offline = false
  /** Next N API calls answer 429 with this Retry-After (seconds). */
  rateLimit = { remaining: 0, retryAfter: 1 }
  /** Current valid access token; any other is answered 401 expired_access_token. */
  accessToken = 'at-0'
  refreshToken = 'rt-0'
  clientId = 'app-key'
  /** Codes accepted at the token endpoint, with the PKCE verifier they expect. */
  readonly codes = new Map<string, string>()
  quotaBytes = Number.POSITIVE_INFINITY
  private seq = 0
  private ids = 0
  private tokens = 0
  private cursors = new Map<string, CursorState>()
  private sessions = new Map<string, Uint8Array[]>()

  constructor(readonly clock: VirtualClock) {}

  /** Adds an authorization code the token endpoint will exchange (verifier = PKCE code_verifier). */
  grant(code: string, verifier: string): void {
    this.codes.set(code, verifier)
  }

  serve(): { url: string; stop: () => void } {
    const server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) })
    return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
  }

  readonly fetch = (url: string, init: RequestInit): Promise<Response> => this.handle(new Request(url, init))

  async handle(req: Request): Promise<Response> {
    if (this.offline) throw new TypeError('Failed to fetch')
    const url = new URL(req.url)
    const route = url.pathname
    this.calls.push(route)
    if (route === '/oauth2/token') return this.token(new URLSearchParams(await req.text()))
    if (this.rateLimit.remaining > 0) {
      this.rateLimit.remaining--
      return new Response('{"error_summary":"too_many_requests/"}', {
        status: 429,
        headers: { 'Retry-After': String(this.rateLimit.retryAfter) },
      })
    }
    if (req.headers.get('Authorization') !== `Bearer ${this.accessToken}`)
      return json({ error_summary: 'expired_access_token/', error: { '.tag': 'expired_access_token' } }, 401)
    const argHeader = req.headers.get('Dropbox-API-Arg')
    if (argHeader !== null) {
      this.argHeaders.push(argHeader)
      if (/[^\x20-\x7e]/.test(argHeader)) return new Response('non-ASCII header', { status: 400 })
    }
    const arg = argHeader !== null ? JSON.parse(argHeader) : route.startsWith('/2/') ? await req.json() : {}
    const body = argHeader !== null ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array()
    switch (route) {
      case '/2/files/list_folder':
        return this.listFolder(arg)
      case '/2/files/list_folder/continue':
        return this.continue(arg.cursor)
      case '/2/files/download':
        return this.download(arg.path)
      case '/2/files/upload':
        return this.upload(arg, body)
      case '/2/files/upload_session/start': {
        const id = `s${this.sessions.size}`
        this.sessions.set(id, [body])
        return json({ session_id: id })
      }
      case '/2/files/upload_session/append_v2':
        return this.append(arg.cursor, body) ?? json(null)
      case '/2/files/upload_session/finish': {
        const err = this.append(arg.cursor, body)
        if (err) return err
        const chunks = this.sessions.get(arg.cursor.session_id) ?? []
        this.sessions.delete(arg.cursor.session_id)
        return this.upload(arg.commit, concat(chunks))
      }
      default:
        return new Response('unknown endpoint', { status: 404 })
    }
  }

  private token(form: URLSearchParams): Response {
    if (form.get('client_id') !== this.clientId) return json({ error: 'invalid_client' }, 400)
    if (form.has('client_secret')) return json({ error: 'secret must not be sent' }, 400)
    if (form.get('grant_type') === 'authorization_code') {
      const code = form.get('code') ?? ''
      if (this.codes.get(code) !== form.get('code_verifier')) return json({ error: 'invalid_grant' }, 400)
      this.codes.delete(code)
      this.accessToken = `at-${++this.tokens}`
      return json({
        access_token: this.accessToken,
        token_type: 'bearer',
        expires_in: 14400,
        refresh_token: this.refreshToken,
        account_id: 'dbid:fake',
      })
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (form.get('refresh_token') !== this.refreshToken) return json({ error: 'invalid_grant' }, 400)
      this.refreshes.push(this.accessToken)
      this.accessToken = `at-${++this.tokens}`
      return json({ access_token: this.accessToken, token_type: 'bearer', expires_in: 14400 })
    }
    return json({ error: 'unsupported_grant_type' }, 400)
  }

  /** Simulates the access token expiring server-side. */
  expire(): void {
    this.accessToken = `at-${++this.tokens}-unknown`
  }

  /** Stores a file as another client would. */
  write(path: string, bytes: Uint8Array): FileRec {
    const lower = path.toLowerCase()
    const prev = this.files.get(lower)
    const rec: FileRec = {
      id: prev?.id ?? `id:${++this.ids}`,
      path: prev?.path ?? path,
      bytes,
      modified: this.clock.now(),
      seq: ++this.seq,
    }
    this.files.set(lower, rec)
    return rec
  }

  private under(dir: string): string[] {
    const d = dir.toLowerCase()
    return [...this.files.keys()].filter((k) => k.startsWith(`${d}/`))
  }

  private listFolder(arg: { path: string; recursive?: boolean; limit?: number }): Response {
    if (arg.path !== '' && this.under(arg.path).length === 0)
      return json({ error_summary: 'path/not_found/..', error: { '.tag': 'path' } }, 409)
    // Dropbox returns entries in no particular order: shuffle deterministically by reversing.
    const pending = this.under(arg.path).reverse()
    return this.page(this.newCursor({ dir: arg.path, pending, seq: this.seq, limit: arg.limit ?? 3 }))
  }

  private newCursor(s: CursorState): string {
    const c = `c${this.cursors.size}`
    this.cursors.set(c, s)
    return c
  }

  private page(cursor: string): Response {
    const s = this.cursors.get(cursor)
    if (!s) return json({ error_summary: 'reset/' }, 409)
    let entries: FileRec[]
    let hasMore = false
    let next: CursorState
    if (s.pending) {
      const take = s.pending.slice(0, s.limit)
      const rest = s.pending.slice(s.limit)
      entries = take.map((k) => this.files.get(k)).filter((f): f is FileRec => f !== undefined)
      hasMore = rest.length > 0
      next = hasMore ? { ...s, pending: rest } : { dir: s.dir, seq: s.seq, limit: s.limit }
    } else {
      entries = this.under(s.dir)
        .map((k) => this.files.get(k) as FileRec)
        .filter((f) => f.seq > s.seq)
      next = { dir: s.dir, seq: this.seq, limit: s.limit }
    }
    return json({
      entries: [
        { '.tag': 'folder', path_display: s.dir || '/', id: 'id:folder' },
        ...entries.map((f) => ({
          '.tag': 'file',
          id: f.id,
          path_display: f.path,
          path_lower: f.path.toLowerCase(),
          size: f.bytes.length,
          server_modified: new Date(Math.floor(f.modified / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
        })),
      ],
      cursor: this.newCursor(next),
      has_more: hasMore,
    })
  }

  private continue(cursor: string): Response {
    return this.page(cursor)
  }

  private download(path: string): Response {
    const f = path.startsWith('id:')
      ? [...this.files.values()].find((x) => x.id === path)
      : this.files.get(path.toLowerCase())
    if (!f) return json({ error_summary: 'path/not_found/...', error: { '.tag': 'path' } }, 409)
    return new Response(f.bytes as BodyInit, {
      headers: { 'Dropbox-API-Result': JSON.stringify({ id: f.id, size: f.bytes.length }) },
    })
  }

  private upload(arg: { path: string; mode?: string }, body: Uint8Array): Response {
    if (arg.mode !== 'overwrite') return json({ error_summary: 'path/conflict/' }, 409)
    const used = [...this.files.values()].reduce((n, f) => n + f.bytes.length, 0)
    if (used + body.length > this.quotaBytes) return json({ error_summary: 'path/insufficient_space/..' }, 409)
    const f = this.write(arg.path, body)
    return json({ id: f.id, path_display: f.path, size: body.length })
  }

  private append(cursor: { session_id: string; offset: number }, body: Uint8Array): Response | undefined {
    const chunks = this.sessions.get(cursor.session_id)
    if (!chunks) return json({ error_summary: 'lookup_failed/not_found/' }, 409)
    const have = chunks.reduce((n, c) => n + c.length, 0)
    if (have !== cursor.offset) return json({ error_summary: 'lookup_failed/incorrect_offset/' }, 409)
    chunks.push(body)
    return undefined
  }
}

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
