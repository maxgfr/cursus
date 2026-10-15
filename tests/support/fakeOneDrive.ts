/**
 * In-memory Microsoft Graph (OneDrive app folder) speaking HTTP: path and item addressing, `children` with
 * `$top` paging through `@odata.nextLink`, simple uploads, upload sessions, and the identity platform token
 * endpoint (under `/oauth`). Use `fetch` as an injected fetch, or `serve()` behind Bun.serve.
 * Paths are case-insensitive and case-preserving, like OneDrive.
 */
interface Node {
  id: string
  /** Display path below the app folder, '' for the app folder itself. */
  path: string
  bytes?: Uint8Array
  modified: number
}

interface Session {
  path: string
  total: number
  parts: Uint8Array[]
  received: number
}

export class FakeOneDrive {
  /** Every item by lower-cased path; folders have no bytes. */
  readonly nodes = new Map<string, Node>()
  readonly calls: string[] = []
  /** Authorization headers seen by upload session URLs (must stay empty). */
  readonly uploadAuth: string[] = []
  readonly refreshes: string[] = []
  offline = false
  rateLimit = { remaining: 0, retryAfter: 1, status: 429 }
  accessToken = 'at-0'
  refreshToken = 'rt-0'
  clientId = 'client-id'
  /** Refresh tokens are refused (as after the 24 h lifetime of a SPA refresh token). */
  refreshExpired = false
  readonly codes = new Map<string, string>()
  /** Answer every upload with 507 (storage full). */
  full = false
  /** Answer every authorized call with 403 accessDenied. */
  deny = false
  private ids = 0
  private tokens = 0
  private sessions = new Map<string, Session>()

  constructor(readonly now: () => number = () => Date.now()) {
    this.nodes.set('', { id: 'root', path: '', modified: 0 })
  }

  grant(code: string, verifier: string): void {
    this.codes.set(code, verifier)
  }

  serve(): { url: string; stop: () => void } {
    const server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) })
    return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
  }

  readonly fetch = (url: string, init: RequestInit): Promise<Response> => this.handle(new Request(url, init))

  /** Stores a file directly (folders created on the way). */
  store(path: string, bytes: Uint8Array): Node {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) this.folder(parts.slice(0, i).join('/'))
    const prev = this.nodes.get(path.toLowerCase())
    const node: Node = { id: prev?.id ?? `item-${++this.ids}`, path: prev?.path ?? path, bytes, modified: this.now() }
    this.nodes.set(path.toLowerCase(), node)
    return node
  }

  private folder(path: string): Node {
    const got = this.nodes.get(path.toLowerCase())
    if (got) return got
    const node: Node = { id: `folder-${++this.ids}`, path, modified: this.now() }
    this.nodes.set(path.toLowerCase(), node)
    return node
  }

  private byId(id: string): Node | undefined {
    for (const n of this.nodes.values()) if (n.id === id) return n
    return undefined
  }

  async handle(req: Request): Promise<Response> {
    if (this.offline) throw new TypeError('Failed to fetch')
    const url = new URL(req.url)
    const route = url.pathname
    this.calls.push(`${req.method} ${route}`)
    if (route === '/oauth/token') return this.token(new URLSearchParams(await req.text()))
    if (this.rateLimit.remaining > 0) {
      this.rateLimit.remaining--
      return new Response('{"error":{"code":"activityLimitReached"}}', {
        status: this.rateLimit.status,
        headers: { 'Retry-After': String(this.rateLimit.retryAfter) },
      })
    }
    if (route.startsWith('/upload/')) return this.upload(req, route.slice('/upload/'.length))
    if (req.headers.get('Authorization') !== `Bearer ${this.accessToken}`)
      return json({ error: { code: 'InvalidAuthenticationToken' } }, 401)
    if (this.deny) return json({ error: { code: 'accessDenied' } }, 403)

    const APP = '/me/drive/special/approot'
    let target: Node | undefined
    let path: string | undefined
    let action: string
    if (route.startsWith(`${APP}:/`)) {
      const rest = route.slice(APP.length + 2)
      const colon = rest.indexOf(':')
      path = rest
        .slice(0, colon)
        .split('/')
        .map((s) => decodeURIComponent(s))
        .join('/')
      action = rest.slice(colon + 1)
      target = this.nodes.get(path.toLowerCase())
    } else if (route.startsWith(`${APP}/`)) {
      path = ''
      target = this.nodes.get('')
      action = route.slice(APP.length)
    } else if (route.startsWith('/me/drive/items/')) {
      const rest = route.slice('/me/drive/items/'.length)
      const slash = rest.indexOf('/')
      target = this.byId(decodeURIComponent(rest.slice(0, slash)))
      path = target?.path
      action = rest.slice(slash)
    } else return json({ error: { code: 'invalidRequest' } }, 400)

    if (action === '/children' && req.method === 'GET') {
      if (!target || target.bytes) return json({ error: { code: 'itemNotFound' } }, 404)
      return this.children(url, target)
    }
    if (action === '/content' && req.method === 'GET') {
      if (!target?.bytes) return json({ error: { code: 'itemNotFound' } }, 404)
      return new Response(target.bytes as BodyInit, { status: 200 })
    }
    if (action === '/content' && req.method === 'PUT' && path !== undefined) {
      if (this.full) return json({ error: { code: 'quotaLimitReached' } }, 507)
      if (url.searchParams.get('@microsoft.graph.conflictBehavior') !== 'replace')
        return json({ error: { code: 'nameAlreadyExists' } }, 409)
      const node = this.store(path, new Uint8Array(await req.arrayBuffer()))
      return json(this.item(node), 201)
    }
    if (action === '/createUploadSession' && req.method === 'POST' && path !== undefined) {
      const sid = `s${this.sessions.size + 1}`
      this.sessions.set(sid, { path, total: -1, parts: [], received: 0 })
      return json({ uploadUrl: `${url.origin}/upload/${sid}` })
    }
    return json({ error: { code: 'invalidRequest' } }, 400)
  }

  private item(n: Node) {
    const name = n.path.slice(n.path.lastIndexOf('/') + 1)
    return n.bytes
      ? { id: n.id, name, size: n.bytes.length, file: {}, lastModifiedDateTime: new Date(n.modified).toISOString() }
      : { id: n.id, name, folder: {} }
  }

  private children(url: URL, dir: Node): Response {
    const lower = dir.path.toLowerCase()
    const kids = [...this.nodes.entries()]
      .filter(([k]) => k !== '' && k !== lower && (lower === '' ? !k.includes('/') : k.startsWith(`${lower}/`)))
      .filter(([k]) => !k.slice(lower === '' ? 0 : lower.length + 1).includes('/'))
      .map(([, n]) => n)
      // Graph's order is not the key order: listings must not rely on it.
      .sort((a, b) => (a.id < b.id ? 1 : -1))
    const top = Number(url.searchParams.get('$top') ?? 200)
    const skip = Number(url.searchParams.get('$skiptoken') ?? 0)
    const page = kids.slice(skip, skip + top)
    const body: Record<string, unknown> = { value: page.map((n) => this.item(n)) }
    if (skip + top < kids.length) {
      const next = new URL(url.href)
      next.searchParams.set('$skiptoken', String(skip + top))
      body['@odata.nextLink'] = next.href
    }
    return json(body)
  }

  private async upload(req: Request, sid: string): Promise<Response> {
    const auth = req.headers.get('Authorization')
    if (auth !== null) this.uploadAuth.push(auth)
    const s = this.sessions.get(sid)
    if (!s) return json({ error: { code: 'itemNotFound' } }, 404)
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers.get('Content-Range') ?? '')
    if (!m) return json({ error: { code: 'invalidRange' } }, 400)
    const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const part = new Uint8Array(await req.arrayBuffer())
    if (start !== s.received || end - start + 1 !== part.length) return json({ error: { code: 'invalidRange' } }, 416)
    s.parts.push(part)
    s.received += part.length
    s.total = total
    if (s.received < total) return json({ nextExpectedRanges: [`${s.received}-`] }, 202)
    const all = new Uint8Array(total)
    let at = 0
    for (const p of s.parts) {
      all.set(p, at)
      at += p.length
    }
    this.sessions.delete(sid)
    return json(this.item(this.store(s.path, all)), 201)
  }

  private token(form: URLSearchParams): Response {
    if (form.get('client_id') !== this.clientId) return json({ error: 'invalid_client' }, 400)
    if (form.get('scope') !== 'Files.ReadWrite.AppFolder offline_access') return json({ error: 'invalid_scope' }, 400)
    const grant = form.get('grant_type')
    if (grant === 'authorization_code') {
      const code = form.get('code') ?? ''
      const verifier = this.codes.get(code)
      if (verifier === undefined || verifier !== form.get('code_verifier')) return json({ error: 'invalid_grant' }, 400)
      this.codes.delete(code)
    } else if (grant === 'refresh_token') {
      this.refreshes.push(form.get('refresh_token') ?? '')
      if (this.refreshExpired || form.get('refresh_token') !== this.refreshToken)
        return json({ error: 'invalid_grant', error_description: 'AADSTS700084: refresh token expired' }, 400)
    } else return json({ error: 'unsupported_grant_type' }, 400)
    this.tokens++
    this.accessToken = `at-${this.tokens}`
    this.refreshToken = `rt-${this.tokens}`
    return json({ access_token: this.accessToken, refresh_token: this.refreshToken, expires_in: 3600 })
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
