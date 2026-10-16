import { sha1 } from '@noble/hashes/legacy.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { RemoteError } from '../../contracts/errors'
import type { Entry, Key, RemoteStore } from '../../contracts/remote'
import { destinationId, normalizePrefix } from '../identity'
import type { Timers } from '../scheduler'

/**
 * A GitHub repository as a destination, through the REST API (Git Data API for writes and listings).
 *
 * Every object is stored as base64 text at `<root>/<key>`: Git trees only take inline content as UTF-8 text.
 * GitHub's secondary rate limits allow few content-creating requests, so `put` only stages the object; staged
 * objects are written as ONE commit (one or a few trees, one commit, one fast-forward ref update) before any
 * `list` or `get`, after a short delay, or on an explicit `flush()`. Nothing is ever deleted; an existing key is
 * never rewritten, except under `mirror/`.
 */

export const GITHUB_API = 'https://api.github.com'
export const GITHUB_API_VERSION = '2022-11-28'
/** Folder of the repository that holds the objects when none is given. */
export const DEFAULT_ROOT = 'cursus'
/** Inline content sent in one tree request at most; a larger batch is split into several trees. */
export const MAX_TREE_BYTES = 4 * 1024 * 1024
/** Staged content above which `put` writes at once instead of waiting for the next flush. */
export const MAX_BATCH_BYTES = 16 * 1024 * 1024
export const FLUSH_DELAY_MS = 2000
/** File written by the first commit of an empty repository; never listed as an object. */
export const README = 'README.md'
export const README_TEXT =
  'This folder holds a Cursus backup, written by the Cursus app.\n\n' +
  'Its files are encoded objects. Do not edit, move or delete them: the backup would become unreadable.\n'

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** What makes a GitHub destination itself (see `githubDestinationId`). */
export interface GitHubTarget {
  owner: string
  repo: string
  /** Branch to write to; the repository's default branch when empty. */
  branch?: string
  /** Folder inside the repository; `cursus` when empty. */
  root?: string
  apiBase?: string
}

export interface GitHubOptions extends GitHubTarget {
  /** Fine-grained personal access token limited to the repository, with Contents: read and write. */
  token: string
  fetch?: Fetch
  /** Timer for the delayed flush; real timers by default. */
  timers?: Timers
  /** Local time, for `x-ratelimit-reset`. */
  now?: () => number
  flushDelayMs?: number
  maxTreeBytes?: number
  maxBatchBytes?: number
  /** Rebuilds on top of a branch another device moved, at most this many times per flush. */
  maxRefRetries?: number
}

export interface GitHubRemote extends RemoteStore {
  /** Writes the staged objects now, as one commit. Throws a RemoteError and keeps them staged on failure. */
  flush(): Promise<void>
  /** Number of staged objects not written yet. */
  readonly pending: number
}

/** Same owner, repository, branch and folder = same destination, whatever the device. Owner and repo ignore case. */
export function githubDestinationId(t: GitHubTarget): string {
  const repo = `${t.owner.trim().toLowerCase()}/${t.repo.trim().toLowerCase()}#${(t.branch ?? '').trim()}`
  return destinationId({ type: 'github', endpoint: t.apiBase ?? GITHUB_API, bucket: repo, prefix: rootOf(t.root) })
}

const rootOf = (root?: string): string => normalizePrefix(root) || DEFAULT_ROOT

const defaultTimers: Timers = {
  set(fn, ms) {
    const h = setTimeout(fn, ms)
    return () => clearTimeout(h)
  },
}

const enc = new TextEncoder()

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

/** The Git blob id of an ASCII text: sha1("blob <length>\0" + text). */
export function gitBlobSha(text: string): string {
  const body = enc.encode(text)
  const head = enc.encode(`blob ${body.length}\0`)
  const all = new Uint8Array(head.length + body.length)
  all.set(head)
  all.set(body, head.length)
  return bytesToHex(sha1(all))
}

const isMirror = (key: Key): boolean => key.startsWith('mirror/')
const encPath = (p: string): string => p.split('/').map(encodeURIComponent).join('/')

/** Wait asked by GitHub: `retry-after` (seconds), or `x-ratelimit-reset` once `x-ratelimit-remaining` is 0. */
function rateLimitWait(h: Headers, now: number): number | undefined {
  const after = Number(h.get('retry-after') ?? Number.NaN)
  if (Number.isFinite(after)) return Math.max(0, after * 1000)
  if (h.get('x-ratelimit-remaining') === '0') {
    const reset = Number(h.get('x-ratelimit-reset') ?? Number.NaN)
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - now)
  }
  return undefined
}

/** Maps a failed answer to a RemoteError (401 auth, 403/429 rate limit, 413 quota, 5xx network, else permission). */
export async function githubError(res: Response, what: string, now: number): Promise<RemoteError> {
  const text = await res.text().catch(() => '')
  let message = text
  try {
    message = String((JSON.parse(text) as { message?: string }).message ?? text)
  } catch {}
  const detail = `GitHub ${what}: HTTP ${res.status}${message ? ` ${message}` : ''}`
  const wait = rateLimitWait(res.headers, now)
  if (res.status === 401) return new RemoteError('auth', detail)
  if (res.status === 429 || (res.status === 403 && (wait !== undefined || /rate limit/i.test(message))))
    return new RemoteError('rate-limited', detail, wait ?? 60_000)
  if (res.status === 413) return new RemoteError('quota', detail)
  if (res.status >= 500) return new RemoteError('network', detail)
  return new RemoteError('permission', detail)
}

interface Client {
  /** `path` is absolute (`/users/x`) or relative to the repository (`git/...`, or '' for the repository). */
  call(method: string, path: string, o?: { body?: unknown; accept?: string; fresh?: boolean }): Promise<Response>
  fail(res: Response, what: string): Promise<RemoteError>
}

function client(o: {
  owner: string
  repo: string
  token: string
  fetch?: Fetch
  apiBase?: string
  now?: () => number
}): Client {
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init))
  const now = o.now ?? (() => Date.now())
  const api = (o.apiBase ?? GITHUB_API).replace(/\/+$/, '')
  const repoUrl = `${api}/repos/${encodeURIComponent(o.owner.trim())}/${encodeURIComponent(o.repo.trim())}`
  return {
    async call(method, path, co = {}) {
      const url = path.startsWith('/') ? `${api}${path}` : path ? `${repoUrl}/${path}` : repoUrl
      const headers: Record<string, string> = {
        Authorization: `Bearer ${o.token}`,
        Accept: co.accept ?? 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      }
      if (co.body !== undefined) headers['Content-Type'] = 'application/json'
      try {
        return await doFetch(url, {
          method,
          headers,
          ...(co.body !== undefined ? { body: JSON.stringify(co.body) } : {}),
          // A branch head must never come from the HTTP cache (GitHub allows 60 s); objects by id never change.
          ...(co.fresh ? { cache: 'no-store' as RequestCache } : {}),
        })
      } catch (e) {
        throw new RemoteError(
          'network',
          `GitHub ${method} ${path || 'repository'}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    },
    fail: (res, what) => githubError(res, what, now()),
  }
}

interface TreeItem {
  path: string
  type: string
  sha: string
  mode?: string
  size?: number
}
interface TreeAnswer {
  sha: string
  tree: TreeItem[]
  truncated?: boolean
}
interface Head {
  commit: string
  tree: string
  /** key (without the root) → blob sha */
  entries: Map<Key, string>
}
type State = Head | { commit: null; reason: 'empty' | 'missing' }
interface Staged {
  text: string
  sha: string
}

export function githubRemote(o: GitHubOptions): GitHubRemote {
  const root = rootOf(o.root)
  const c = client(o)
  const timers = o.timers ?? defaultTimers
  const flushDelayMs = o.flushDelayMs ?? FLUSH_DELAY_MS
  const maxTreeBytes = o.maxTreeBytes ?? MAX_TREE_BYTES
  const maxBatchBytes = o.maxBatchBytes ?? MAX_BATCH_BYTES
  const maxRefRetries = o.maxRefRetries ?? 5
  const repoName = `${o.owner}/${o.repo}`

  let branchName: string | null = o.branch?.trim() || null
  let cache: Head | null = null
  const staged = new Map<Key, Staged>()
  let stagedBytes = 0
  let failure: RemoteError | null = null
  let running: Promise<void> | null = null
  let cancelTimer: (() => void) | null = null

  const stage = (key: Key, s: Staged | null): void => {
    const prev = staged.get(key)
    if (prev) stagedBytes -= prev.text.length
    if (s) {
      staged.set(key, s)
      stagedBytes += s.text.length
    } else staged.delete(key)
  }

  async function json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) throw await c.fail(res, what)
    return (await res.json()) as T
  }

  /** The repository; a 404 means it does not exist or the token was not given access to it. */
  async function repoInfo(): Promise<{ default_branch: string }> {
    const res = await c.call('GET', '', { fresh: true })
    if (res.status === 404)
      throw new RemoteError('permission', `GitHub repository ${repoName} not found, or the token cannot access it`)
    return json(res, 'repository')
  }

  async function branch(): Promise<string> {
    branchName ??= (await repoInfo()).default_branch
    return branchName
  }

  async function getTree(sha: string, recursive: boolean): Promise<TreeAnswer> {
    return json(await c.call('GET', `git/trees/${sha}${recursive ? '?recursive=1' : ''}`), 'tree')
  }

  /** Every blob under a tree: one recursive call, or a walk of its subtrees when GitHub truncates the answer. */
  async function walk(sha: string, base: string, out: Map<Key, string>): Promise<void> {
    const deep = await getTree(sha, true)
    if (!deep.truncated) {
      for (const e of deep.tree) if (e.type === 'blob') out.set(base + e.path, e.sha)
      return
    }
    for (const e of (await getTree(sha, false)).tree) {
      if (e.type === 'blob') out.set(base + e.path, e.sha)
      else if (e.type === 'tree') await walk(e.sha, `${base}${e.path}/`, out)
    }
  }

  async function readHead(commit: string): Promise<Head> {
    const top = await getTree(commit, true)
    const entries = new Map<Key, string>()
    const strip = `${root}/`
    if (!top.truncated) {
      for (const e of top.tree)
        if (e.type === 'blob' && e.path.startsWith(strip)) entries.set(e.path.slice(strip.length), e.sha)
    } else {
      let sha: string | null = top.sha
      for (const seg of root.split('/')) {
        const t: TreeAnswer = await getTree(sha, false)
        sha = t.tree.find((e) => e.type === 'tree' && e.path === seg)?.sha ?? null
        if (sha === null) break
      }
      if (sha !== null) await walk(sha, '', entries)
    }
    entries.delete(README)
    return { commit, tree: top.sha, entries }
  }

  /** Head of the branch; the tree is read again only when the head moved. */
  async function loadState(): Promise<State> {
    const b = await branch()
    const res = await c.call('GET', `git/ref/heads/${encPath(b)}`, { fresh: true })
    if (res.status === 409) return { commit: null, reason: 'empty' }
    if (res.status === 404) {
      await repoInfo()
      return { commit: null, reason: 'missing' }
    }
    const ref = await json<{ object: { sha: string } }>(res, 'branch')
    if (cache?.commit !== ref.object.sha) cache = await readHead(ref.object.sha)
    return cache
  }

  /** First commit of an empty repository, through the Contents API (the Git Data API refuses empty ones). */
  async function bootstrap(b: string): Promise<void> {
    const res = await c.call('PUT', `contents/${encPath(`${root}/${README}`)}`, {
      body: { message: 'Cursus backup: README', content: toBase64(enc.encode(README_TEXT)), branch: b },
    })
    // 409/422: another device created it first.
    if (!res.ok && res.status !== 409 && res.status !== 422) throw await c.fail(res, 'first commit')
  }

  /** A configured branch that does not exist yet starts from the default branch. */
  async function createBranch(b: string): Promise<void> {
    const main = (await repoInfo()).default_branch
    const res = await c.call('GET', `git/ref/heads/${encPath(main)}`, { fresh: true })
    if (res.status === 409) return bootstrap(b)
    const ref = await json<{ object: { sha: string } }>(res, 'default branch')
    const made = await c.call('POST', 'git/refs', { body: { ref: `refs/heads/${b}`, sha: ref.object.sha } })
    if (!made.ok && made.status !== 422) throw await c.fail(made, 'create branch')
  }

  async function postTree(base: string, items: unknown[]): Promise<string> {
    const res = await c.call('POST', 'git/trees', { body: { base_tree: base, tree: items } })
    return (await json<{ sha: string }>(res, 'write tree')).sha
  }

  /** Writes a batch as one commit on top of the branch; rebuilds on a head another device moved. */
  async function commitBatch(batch: [Key, Staged][]): Promise<void> {
    const uploaded = new Set<string>()
    for (let attempt = 0; ; attempt++) {
      const b = await branch()
      let state = await loadState()
      if (state.commit === null) {
        if (state.reason === 'empty') await bootstrap(b)
        else await createBranch(b)
        state = await loadState()
        if (state.commit === null) throw new RemoteError('network', `GitHub branch ${b} could not be created`)
      }
      const head: Head = state
      const writes = batch.filter(([k, s]) => {
        const have = head.entries.get(k)
        return have === undefined || (isMirror(k) && have !== s.sha)
      })
      if (writes.length === 0) return
      let tree = head.tree
      let items: unknown[] = []
      let inline: string[] = []
      let size = 0
      const send = async (): Promise<void> => {
        if (items.length === 0) return
        tree = await postTree(tree, items)
        for (const sha of inline) uploaded.add(sha)
        items = []
        inline = []
        size = 0
      }
      for (const [k, s] of writes) {
        const path = `${root}/${k}`
        if (!uploaded.has(s.sha) && s.text.length > maxTreeBytes) {
          const res = await c.call('POST', 'git/blobs', { body: { content: s.text, encoding: 'utf-8' } })
          await json(res, 'write blob')
          uploaded.add(s.sha)
        }
        if (uploaded.has(s.sha)) {
          items.push({ path, mode: '100644', type: 'blob', sha: s.sha })
          continue
        }
        if (size + s.text.length > maxTreeBytes) await send()
        items.push({ path, mode: '100644', type: 'blob', content: s.text })
        inline.push(s.sha)
        size += s.text.length
      }
      await send()
      const n = writes.length
      const commit = await json<{ sha: string }>(
        await c.call('POST', 'git/commits', {
          body: { message: `Cursus backup: ${n} ${n === 1 ? 'object' : 'objects'}`, tree, parents: [head.commit] },
        }),
        'write commit',
      )
      const res = await c.call('PATCH', `git/refs/heads/${encPath(b)}`, { body: { sha: commit.sha, force: false } })
      if (res.ok) {
        const entries = new Map(head.entries)
        for (const [k, s] of writes) entries.set(k, s.sha)
        cache = { commit: commit.sha, tree, entries }
        return
      }
      // 422: not a fast forward, another device pushed. New paths never conflict: rebuild on its head.
      if (res.status !== 422) throw await c.fail(res, 'update branch')
      if (attempt >= maxRefRetries)
        throw new RemoteError('network', `GitHub branch ${b} kept moving during ${attempt + 1} attempts`)
    }
  }

  async function doFlush(): Promise<void> {
    cancelTimer?.()
    cancelTimer = null
    if (staged.size === 0) return
    const batch = [...staged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    try {
      await commitBatch(batch)
    } catch (e) {
      failure = e instanceof RemoteError ? e : new RemoteError('network', `GitHub: ${String(e)}`)
      throw failure
    }
    failure = null
    for (const [k, s] of batch) if (staged.get(k) === s) stage(k, null)
  }

  /** One flush at a time; a flush waits for the one in progress, then writes what is still staged. */
  function flush(): Promise<void> {
    const p = (running ?? Promise.resolve()).catch(() => {}).then(doFlush)
    running = p
    const clear = (): void => {
      if (running === p) running = null
    }
    p.then(clear, clear)
    return p
  }

  async function settle(): Promise<void> {
    if (staged.size > 0 || running) await flush()
  }

  async function getBlob(sha: string): Promise<Uint8Array | null> {
    const res = await c.call('GET', `git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json' })
    if (res.status === 404) return null
    if (!res.ok) throw await c.fail(res, 'read object')
    // Raw media type: the stored base64 text. Otherwise the JSON form, whose content is base64 of that text
    // (base64 never starts with `{`, so the body tells which one came back).
    let text = await res.text()
    if (text.startsWith('{')) {
      const blob = JSON.parse(text) as { content: string; encoding: string }
      text = blob.encoding === 'base64' ? atob(blob.content.replace(/\s/g, '')) : blob.content
    }
    try {
      return fromBase64(text.trim())
    } catch {
      // Not base64: edited outside Cursus. The raw bytes fail the integrity check downstream.
      return enc.encode(text)
    }
  }

  return {
    id: githubDestinationId(o),
    // Every listing reads the whole tree in one call: one full listing per round is the cheapest.
    incremental: 'none',
    get pending() {
      return staged.size
    },
    flush,
    list(prefix, lo) {
      return {
        async *[Symbol.asyncIterator]() {
          await settle()
          const state = await loadState()
          if (state.commit === null) return
          const out: Entry[] = []
          for (const [key, sha] of state.entries) {
            if (!key.startsWith(prefix)) continue
            if (lo?.startAfter !== undefined && key <= lo.startAfter) continue
            out.push({ key, handle: sha })
          }
          out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          yield* out
        },
      }
    },
    async get(e) {
      await settle()
      if (e.handle) {
        const body = await getBlob(e.handle)
        if (body) return body
        // Certain only if the repository itself is readable.
        await loadState()
        return null
      }
      const state = await loadState()
      if (state.commit === null) return null
      const sha = state.entries.get(e.key)
      if (sha === undefined) return null
      const body = await getBlob(sha)
      if (!body) throw new RemoteError('network', `GitHub object ${e.key} is listed but cannot be read`)
      return body
    },
    async put(key, body) {
      const text = toBase64(body)
      const s: Staged = { text, sha: gitBlobSha(text) }
      const have = cache?.entries.get(key)
      // Already there: identical, or immutable (only mirror/ is ever rewritten).
      if (have !== undefined && (have === s.sha || !isMirror(key))) {
        stage(key, null)
        if (!failure) return
      } else stage(key, s)
      // After a failed flush, or with too much staged, write now: a failing destination fails the put.
      if (failure || stagedBytes > maxBatchBytes) {
        await flush()
        return
      }
      cancelTimer ??= timers.set(() => {
        cancelTimer = null
        flush().catch(() => {})
      }, flushDelayMs)
    },
  }
}

export type GitHubProblem = 'token' | 'not-found' | 'no-access' | 'read-only' | 'rate-limited' | 'network'
export type GitHubCheck =
  | { ok: true; defaultBranch: string; private: boolean }
  | { ok: false; problem: GitHubProblem; detail: string; retryAfterMs?: number }

/**
 * Validates a token and repository for the settings form, with read-only calls. GitHub answers 404 both for a
 * private repository that does not exist and for one the token cannot see: `not-found` is certain only for an
 * owner that does not exist, `no-access` covers both other cases. `read-only`: no push permission, or archived.
 */
export async function checkGitHub(o: {
  owner: string
  repo: string
  token: string
  fetch?: Fetch
  apiBase?: string
  now?: () => number
}): Promise<GitHubCheck> {
  const c = client(o)
  const fromError = (e: unknown): GitHubCheck => {
    if (!(e instanceof RemoteError)) throw e
    const problem: GitHubProblem =
      e.kind === 'auth'
        ? 'token'
        : e.kind === 'rate-limited'
          ? 'rate-limited'
          : e.kind === 'network'
            ? 'network'
            : 'no-access'
    return {
      ok: false,
      problem,
      detail: e.message,
      ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
    }
  }
  try {
    const res = await c.call('GET', '', { fresh: true })
    if (res.status === 404) {
      const user = await c.call('GET', `/users/${encodeURIComponent(o.owner.trim())}`)
      if (user.status === 404) return { ok: false, problem: 'not-found', detail: `No GitHub account ${o.owner}` }
      if (!user.ok) throw await c.fail(user, 'owner')
      return {
        ok: false,
        problem: 'no-access',
        detail: `Repository ${o.owner}/${o.repo} not found, or not among the repositories of this token`,
      }
    }
    if (!res.ok) throw await c.fail(res, 'repository')
    const r = (await res.json()) as {
      default_branch: string
      private?: boolean
      archived?: boolean
      permissions?: { push?: boolean }
    }
    if (r.archived) return { ok: false, problem: 'read-only', detail: `Repository ${o.owner}/${o.repo} is archived` }
    if (r.permissions?.push === false)
      return { ok: false, problem: 'read-only', detail: `No write access to ${o.owner}/${o.repo}` }
    return { ok: true, defaultBranch: r.default_branch, private: r.private === true }
  } catch (e) {
    return fromError(e)
  }
}
