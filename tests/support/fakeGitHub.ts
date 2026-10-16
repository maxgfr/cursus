import { sha1 } from '@noble/hashes/legacy.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/**
 * In-memory GitHub REST API for one repository, speaking HTTP: the repository and user endpoints, the Git Data
 * API (refs, trees with recursive and truncated listings, blobs, commits) and the Contents API PUT used for the
 * first commit of an empty repository. Use `fetch` as an injected fetch, or `serve()` behind Bun.serve.
 * Blob ids are real Git blob ids; tree and commit ids are content hashes of a simpler form.
 */
type TreeEntry = { type: 'blob' | 'tree'; sha: string; mode: string }
type Obj =
  | { type: 'blob'; bytes: Uint8Array }
  | { type: 'tree'; entries: Map<string, TreeEntry> }
  | { type: 'commit'; tree: string; parents: string[]; message: string }

interface TreeItemIn {
  path: string
  mode?: string
  type?: string
  sha?: string | null
  content?: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function blobSha(bytes: Uint8Array): string {
  const head = enc.encode(`blob ${bytes.length}\0`)
  const all = new Uint8Array(head.length + bytes.length)
  all.set(head)
  all.set(bytes, head.length)
  return bytesToHex(sha1(all))
}

const hashOf = (s: string): string => bytesToHex(sha1(enc.encode(s)))

export class FakeGitHub {
  owner = 'ada'
  repo = 'notes'
  defaultBranch = 'main'
  token = 'github_pat_test'
  /** The repository exists. */
  exists = true
  /** The token was given access to the repository (GitHub answers 404 otherwise). */
  accessible = true
  archived = false
  private = true
  permissions = { admin: false, push: true, pull: true }
  readonly users = new Set(['ada'])
  offline = false
  /** Recursive tree listings with more entries than this are truncated, as GitHub does for large trees. */
  truncateAt = Number.POSITIVE_INFINITY
  /** The next `remaining` calls are refused with this status, headers and message. */
  rateLimit: { remaining: number; status: number; headers: Record<string, string>; message: string } = {
    remaining: 0,
    status: 403,
    headers: {},
    message: 'API rate limit exceeded',
  }
  /** Before each of the next N ref updates, another device pushes a commit (the ref moves). */
  racePushes = 0
  /** The next N calls whose route starts with `failOn.route` answer `failOn.status`. */
  failOn: { route: string; status: number; remaining: number } | null = null
  readonly objects = new Map<string, Obj>()
  readonly refs = new Map<string, string>()
  /** `METHOD /route`, the route relative to the repository (`/git/trees`), or absolute for `/users/...`. */
  readonly calls: string[] = []
  readonly headers: Headers[] = []
  /** Parsed JSON bodies of the calls that send one, in call order. */
  readonly bodies: { call: string; body: Record<string, unknown> }[] = []
  readonly messages: string[] = []
  deletions = 0
  forcedUpdates = 0
  private races = 0

  /** `empty`: a repository without any commit, as GitHub creates it without a README. */
  constructor(o: { empty?: boolean } = {}) {
    if (!o.empty) this.commitFiles({ 'README.md': '# notes\n' }, this.defaultBranch, 'Initial commit')
  }

  serve(): { url: string; stop: () => void } {
    const server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) })
    return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
  }

  readonly fetch = (url: string, init: RequestInit): Promise<Response> => this.handle(new Request(url, init))

  /** Calls that create content (every method but GET). */
  get writes(): number {
    return this.calls.filter((c) => !c.startsWith('GET ')).length
  }

  count(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length
  }

  /** Files of a branch, path → bytes. */
  files(branch = this.defaultBranch): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>()
    const head = this.refs.get(branch)
    if (!head) return out
    for (const [path, sha] of this.flatten(this.commit(head).tree)) out.set(path, this.blob(sha))
    return out
  }

  /** Pushes a commit as another client would; creates the branch when missing. */
  commitFiles(files: Record<string, string | Uint8Array>, branch = this.defaultBranch, message = 'Elsewhere'): string {
    const head = this.refs.get(branch)
    const flat = head ? this.flatten(this.commit(head).tree) : new Map<string, string>()
    for (const [path, body] of Object.entries(files))
      flat.set(path, this.putBlob(typeof body === 'string' ? enc.encode(body) : body))
    const sha = this.putCommit(this.buildTree(flat), head ? [head] : [], message)
    this.refs.set(branch, sha)
    return sha
  }

  async handle(req: Request): Promise<Response> {
    if (this.offline) throw new TypeError('Failed to fetch')
    const url = new URL(req.url)
    const prefix = `/repos/${this.owner}/${this.repo}`
    const p = url.pathname
    const inRepo = p.toLowerCase() === prefix.toLowerCase() || p.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
    const route = inRepo ? p.slice(prefix.length) : p
    this.calls.push(`${req.method} ${route}`)
    this.headers.push(req.headers)
    if (this.rateLimit.remaining > 0) {
      this.rateLimit.remaining--
      return json({ message: this.rateLimit.message }, this.rateLimit.status, this.rateLimit.headers)
    }
    if (req.headers.get('Authorization') !== `Bearer ${this.token}`) return json({ message: 'Bad credentials' }, 401)
    if (req.headers.get('X-GitHub-Api-Version') !== '2022-11-28') return json({ message: 'Bad API version' }, 400)
    if (this.failOn && this.failOn.remaining > 0 && `${req.method} ${route}`.startsWith(this.failOn.route)) {
      this.failOn.remaining--
      return json({ message: 'Injected failure' }, this.failOn.status)
    }
    if (req.method === 'DELETE') {
      this.deletions++
      return json({ message: 'Deletion refused by the fake' }, 403)
    }
    if (p.startsWith('/users/')) {
      return this.users.has(decodeURIComponent(p.slice('/users/'.length)))
        ? json({ login: p.slice(7) })
        : json({ message: 'Not Found' }, 404)
    }
    if (!inRepo || !this.exists || !this.accessible) return json({ message: 'Not Found' }, 404)
    const body = req.method === 'GET' ? undefined : ((await req.json()) as Record<string, unknown>)
    if (body) this.bodies.push({ call: `${req.method} ${route}`, body })
    if (route === '' && req.method === 'GET')
      return json({
        full_name: `${this.owner}/${this.repo}`,
        default_branch: this.defaultBranch,
        private: this.private,
        archived: this.archived,
        permissions: this.permissions,
      })
    if (route.startsWith('/contents/') && req.method === 'PUT')
      return this.putContents(decodeURIComponent(route.slice('/contents/'.length)), body ?? {})
    if (!route.startsWith('/git/')) return json({ message: 'Not Found' }, 404)
    if (this.refs.size === 0) return json({ message: 'Git Repository is empty.' }, 409)
    const git = route.slice('/git/'.length)
    if (req.method === 'GET' && git.startsWith('ref/heads/')) {
      const sha = this.refs.get(decodeURIComponent(git.slice('ref/heads/'.length)))
      return sha ? json({ ref: git.slice(4), object: { sha, type: 'commit' } }) : json({ message: 'Not Found' }, 404)
    }
    if (req.method === 'GET' && git.startsWith('trees/'))
      return this.getTree(decodeURIComponent(git.slice('trees/'.length)), url.searchParams.has('recursive'))
    if (req.method === 'GET' && git.startsWith('blobs/')) return this.getBlob(git.slice('blobs/'.length), req)
    if (req.method === 'GET' && git.startsWith('commits/')) {
      const o = this.objects.get(git.slice('commits/'.length))
      return o?.type === 'commit'
        ? json({ sha: git.slice(8), tree: { sha: o.tree } })
        : json({ message: 'Not Found' }, 404)
    }
    if (req.method === 'POST' && git === 'trees') return this.postTree(body ?? {})
    if (req.method === 'POST' && git === 'blobs') return this.postBlob(body ?? {})
    if (req.method === 'POST' && git === 'commits') return this.postCommit(body ?? {})
    if (req.method === 'POST' && git === 'refs') {
      const ref = String(body?.ref ?? '')
      const sha = String(body?.sha ?? '')
      if (!ref.startsWith('refs/heads/')) return json({ message: 'Reference name is invalid' }, 422)
      const name = ref.slice('refs/heads/'.length)
      if (this.refs.has(name)) return json({ message: 'Reference already exists' }, 422)
      if (this.objects.get(sha)?.type !== 'commit') return json({ message: 'Object does not exist' }, 422)
      this.refs.set(name, sha)
      return json({ ref, object: { sha } }, 201)
    }
    if (req.method === 'PATCH' && git.startsWith('refs/heads/'))
      return this.patchRef(decodeURIComponent(git.slice('refs/heads/'.length)), body ?? {})
    return json({ message: 'Not Found' }, 404)
  }

  private putContents(path: string, body: Record<string, unknown>): Response {
    const branch = typeof body.branch === 'string' ? body.branch : this.defaultBranch
    const head = this.refs.get(branch)
    if (!head && this.refs.size > 0) return json({ message: `Branch ${branch} not found` }, 404)
    if (head && this.flatten(this.commit(head).tree).has(path) && !body.sha)
      return json({ message: '"sha" wasn\'t supplied.' }, 422)
    const bytes = Uint8Array.from(Buffer.from(String(body.content ?? ''), 'base64'))
    const sha = this.commitFiles({ [path]: bytes }, branch, String(body.message ?? ''))
    this.messages.push(String(body.message ?? ''))
    return json({ content: { path, sha: blobSha(bytes) }, commit: { sha } }, 201)
  }

  private getTree(ref: string, recursive: boolean): Response {
    let sha = this.refs.has(ref) ? (this.refs.get(ref) as string) : ref
    const o = this.objects.get(sha)
    if (o?.type === 'commit') sha = o.tree
    else if (o?.type !== 'tree') return json({ message: 'Not Found' }, 404)
    const out: { path: string; mode: string; type: string; sha: string; size?: number }[] = []
    const visit = (tree: string, base: string): void => {
      for (const [name, e] of this.tree(tree)) {
        out.push({
          path: base + name,
          mode: e.mode,
          type: e.type,
          sha: e.sha,
          ...(e.type === 'blob' ? { size: this.blob(e.sha).length } : {}),
        })
        if (recursive && e.type === 'tree') visit(e.sha, `${base}${name}/`)
      }
    }
    visit(sha, '')
    const truncated = recursive && out.length > this.truncateAt
    return json({ sha, tree: truncated ? out.slice(0, this.truncateAt) : out, truncated })
  }

  private getBlob(sha: string, req: Request): Response {
    const o = this.objects.get(sha)
    if (o?.type !== 'blob') return json({ message: 'Not Found' }, 404)
    if (req.headers.get('Accept') === 'application/vnd.github.raw+json')
      return new Response(o.bytes as BodyInit, { headers: { 'Content-Type': 'application/vnd.github.raw' } })
    const b64 = (
      Buffer.from(o.bytes)
        .toString('base64')
        .match(/.{1,60}/g) ?? []
    ).join('\n')
    return json({ sha, size: o.bytes.length, content: b64, encoding: 'base64' })
  }

  private postBlob(body: Record<string, unknown>): Response {
    const content = String(body.content ?? '')
    const bytes = body.encoding === 'base64' ? Uint8Array.from(Buffer.from(content, 'base64')) : enc.encode(content)
    return json({ sha: this.putBlob(bytes) }, 201)
  }

  private postTree(body: Record<string, unknown>): Response {
    const base = body.base_tree === undefined ? undefined : String(body.base_tree)
    if (base !== undefined && this.objects.get(base)?.type !== 'tree')
      return json({ message: 'Invalid base_tree' }, 422)
    const flat = base ? this.flatten(base) : new Map<string, string>()
    for (const item of (body.tree ?? []) as TreeItemIn[]) {
      if (item.sha === null) {
        this.deletions++
        flat.delete(item.path)
      } else if (typeof item.content === 'string') flat.set(item.path, this.putBlob(enc.encode(item.content)))
      else if (item.sha && this.objects.get(item.sha)?.type === 'blob') flat.set(item.path, item.sha)
      else return json({ message: `Invalid tree item ${item.path}` }, 422)
    }
    const sha = this.buildTree(flat)
    return json({ sha, tree: [...this.tree(sha)].map(([path, e]) => ({ path, ...e })) }, 201)
  }

  private postCommit(body: Record<string, unknown>): Response {
    const tree = String(body.tree ?? '')
    const parents = ((body.parents ?? []) as string[]).map(String)
    if (this.objects.get(tree)?.type !== 'tree') return json({ message: 'Tree not found' }, 422)
    if (parents.some((p) => this.objects.get(p)?.type !== 'commit')) return json({ message: 'Parent not found' }, 422)
    const message = String(body.message ?? '')
    this.messages.push(message)
    return json({ sha: this.putCommit(tree, parents, message), tree: { sha: tree } }, 201)
  }

  private patchRef(branch: string, body: Record<string, unknown>): Response {
    const current = this.refs.get(branch)
    if (!current) return json({ message: 'Reference does not exist' }, 422)
    if (this.racePushes > 0) {
      this.racePushes--
      this.commitFiles({ [`elsewhere/${++this.races}.txt`]: `push ${this.races}` }, branch)
    }
    const sha = String(body.sha ?? '')
    if (this.objects.get(sha)?.type !== 'commit') return json({ message: 'Object does not exist' }, 422)
    const head = this.refs.get(branch) as string
    if (!this.isAncestor(head, sha)) {
      if (body.force !== true) return json({ message: 'Update is not a fast forward' }, 422)
      this.forcedUpdates++
    }
    this.refs.set(branch, sha)
    return json({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } })
  }

  private isAncestor(ancestor: string, of: string): boolean {
    const todo = [of]
    while (todo.length > 0) {
      const c = todo.pop() as string
      if (c === ancestor) return true
      todo.push(...this.commit(c).parents)
    }
    return false
  }

  private putBlob(bytes: Uint8Array): string {
    const sha = blobSha(bytes)
    this.objects.set(sha, { type: 'blob', bytes })
    return sha
  }

  private putCommit(tree: string, parents: string[], message: string): string {
    const sha = hashOf(JSON.stringify(['commit', tree, parents, message, this.objects.size]))
    this.objects.set(sha, { type: 'commit', tree, parents, message })
    return sha
  }

  /** Nested trees from flat paths (path → blob sha). */
  private buildTree(flat: Map<string, string>): string {
    const entries = new Map<string, TreeEntry>()
    const sub = new Map<string, Map<string, string>>()
    for (const [path, sha] of flat) {
      const slash = path.indexOf('/')
      if (slash < 0) entries.set(path, { type: 'blob', sha, mode: '100644' })
      else {
        const dir = path.slice(0, slash)
        const m = sub.get(dir) ?? new Map<string, string>()
        m.set(path.slice(slash + 1), sha)
        sub.set(dir, m)
      }
    }
    for (const [dir, m] of sub) entries.set(dir, { type: 'tree', sha: this.buildTree(m), mode: '040000' })
    const sorted = new Map([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    const sha = hashOf(JSON.stringify(['tree', [...sorted]]))
    this.objects.set(sha, { type: 'tree', entries: sorted })
    return sha
  }

  private flatten(tree: string, base = ''): Map<string, string> {
    const out = new Map<string, string>()
    for (const [name, e] of this.tree(tree)) {
      if (e.type === 'blob') out.set(base + name, e.sha)
      else for (const [p, s] of this.flatten(e.sha, `${base}${name}/`)) out.set(p, s)
    }
    return out
  }

  private tree(sha: string): Map<string, TreeEntry> {
    const o = this.objects.get(sha)
    if (o?.type !== 'tree') throw new Error(`no tree ${sha}`)
    return o.entries
  }

  private commit(sha: string): { tree: string; parents: string[] } {
    const o = this.objects.get(sha)
    if (o?.type !== 'commit') throw new Error(`no commit ${sha}`)
    return o
  }

  private blob(sha: string): Uint8Array {
    const o = this.objects.get(sha)
    if (o?.type !== 'blob') throw new Error(`no blob ${sha}`)
    return o.bytes
  }

  /** Decoded text of a file, for assertions. */
  text(path: string, branch = this.defaultBranch): string | undefined {
    const b = this.files(branch).get(path)
    return b ? dec.decode(b) : undefined
  }
}

function json(v: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}
