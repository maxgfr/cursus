import { describe, expect, test } from 'bun:test'
import { FakeGitHub } from '../../../../tests/support/fakeGitHub'
import { RemoteError } from '../../contracts/remote'
import { virtualClock } from '../../ports/clock'
import { virtualTimers } from '../scheduler'
import {
  checkGitHub,
  type Fetch,
  FLUSH_DELAY_MS,
  fromBase64,
  type GitHubOptions,
  gitBlobSha,
  githubDestinationId,
  githubRemote,
  README_TEXT,
  toBase64,
} from './github'

const enc = new TextEncoder()
const dec = new TextDecoder()
const T0 = 1_700_000_000_000

function setup(o: Partial<GitHubOptions> & { fake?: FakeGitHub } = {}) {
  const fake = o.fake ?? new FakeGitHub()
  const clock = virtualClock(T0)
  const timers = virtualTimers(clock)
  const { fake: _, ...rest } = o
  const store = githubRemote({
    owner: fake.owner,
    repo: fake.repo,
    token: fake.token,
    fetch: fake.fetch,
    timers,
    now: () => clock.now(),
    ...rest,
  })
  return { fake, clock, timers, store }
}

async function keys(it: AsyncIterable<{ key: string }>): Promise<string[]> {
  const out: string[] = []
  for await (const e of it) out.push(e.key)
  return out
}

async function errorOf(p: Promise<unknown>): Promise<RemoteError> {
  try {
    await p
  } catch (e) {
    if (e instanceof RemoteError) return e
    throw e
  }
  throw new Error('expected a RemoteError')
}

/** Content-creating calls on the Git Data and Contents APIs. */
const creating = (fake: FakeGitHub) => fake.calls.filter((c) => !c.startsWith('GET '))

describe('githubRemote: batching', () => {
  test('N puts make one tree, one commit and one ref update, written before the listing', async () => {
    const { fake, store } = setup()
    for (let i = 0; i < 12; i++) await store.put(`seg/d/${String(i).padStart(10, '0')}`, enc.encode(`s${i}`))
    expect(fake.writes).toBe(0)
    expect(store.pending).toBe(12)
    expect(await keys(store.list('seg/'))).toHaveLength(12)
    expect(creating(fake)).toEqual(['POST /git/trees', 'POST /git/commits', 'PATCH /git/refs/heads/main'])
    expect(store.pending).toBe(0)
    expect(fake.messages).toEqual(['Cursus backup: 12 objects'])
    expect(fake.text('cursus/seg/d/0000000003')).toBe(toBase64(enc.encode('s3')))
    expect(fake.text('README.md')).toBe('# notes\n')
    // A listing of an unchanged branch reads only its head; the tree is known.
    const before = fake.calls.length
    expect(await keys(store.list(''))).toHaveLength(12)
    expect(fake.calls.slice(before)).toEqual(['GET /git/ref/heads/main'])
  })

  test('a get writes the staged objects first', async () => {
    const { fake, store } = setup()
    await store.put('fmt/v1', enc.encode('cursus/1\n'))
    await store.put('ws/01A', new Uint8Array())
    expect(await store.get({ key: 'fmt/v1' })).toEqual(enc.encode('cursus/1\n'))
    expect(fake.count('POST /git/commits')).toBe(1)
    expect(fake.messages).toEqual(['Cursus backup: 2 objects'])
  })

  test('the timer writes staged objects; flush() writes at once; nothing staged writes nothing', async () => {
    const { fake, store, timers } = setup()
    await store.put('a/1', enc.encode('1'))
    expect(timers.pending()).toBe(1)
    timers.advance(FLUSH_DELAY_MS - 1)
    expect(fake.writes).toBe(0)
    timers.advance(1)
    await store.flush()
    expect(fake.writes).toBe(3)
    expect(fake.messages).toEqual(['Cursus backup: 1 object'])
    await store.put('a/2', enc.encode('2'))
    await store.flush()
    expect(timers.pending()).toBe(0)
    expect(fake.writes).toBe(6)
    await store.flush()
    expect(fake.writes).toBe(6)
  })

  test('large batches are split into several trees, still one commit; oversized objects go through blobs', async () => {
    const { fake, store } = setup({ maxTreeBytes: 16 })
    for (const k of ['k/1', 'k/2', 'k/3']) await store.put(k, enc.encode(`012345678${k.slice(2)}`)) // 16 base64 chars each
    await store.put('k/big', new Uint8Array(30))
    await store.flush()
    expect(fake.count('POST /git/blobs')).toBe(1)
    expect(fake.count('POST /git/trees')).toBe(3)
    expect(fake.count('POST /git/commits')).toBe(1)
    expect(fake.count('PATCH ')).toBe(1)
    const trees = fake.bodies.filter((b) => b.call === 'POST /git/trees').map((b) => b.body)
    expect(trees[1]?.base_tree).not.toBe(trees[0]?.base_tree)
    expect(await store.get({ key: 'k/big' })).toEqual(new Uint8Array(30))
  })

  test('too much staged content writes during put', async () => {
    const { fake, store } = setup({ maxBatchBytes: 10 })
    await store.put('a', enc.encode('abc'))
    expect(fake.writes).toBe(0)
    await store.put('b', enc.encode('defghij'))
    expect(fake.writes).toBe(3)
    expect(store.pending).toBe(0)
  })
})

describe('githubRemote: failures', () => {
  test('a failed flush keeps the objects, throws from the listing, and the next put retries at once', async () => {
    const { fake, store } = setup()
    await store.put('seg/a', enc.encode('a'))
    await store.put('seg/b', enc.encode('b'))
    fake.failOn = { route: 'POST /git/commits', status: 502, remaining: 1 }
    const e = await errorOf(keys(store.list('')))
    expect(e.kind).toBe('network')
    expect(store.pending).toBe(2)
    await store.put('seg/c', enc.encode('c'))
    expect(store.pending).toBe(0)
    expect(await keys(store.list('seg/'))).toEqual(['seg/a', 'seg/b', 'seg/c'])
    expect(fake.messages).toEqual(['Cursus backup: 3 objects'])
  })

  test('a failing destination fails the put after a failed flush, and a failed timer flush is kept', async () => {
    const { fake, store, timers } = setup()
    await store.put('seg/a', enc.encode('a'))
    fake.offline = true
    timers.advance(FLUSH_DELAY_MS)
    await store.flush().catch(() => {})
    expect(store.pending).toBe(1)
    expect((await errorOf(store.put('seg/b', enc.encode('b')))).kind).toBe('network')
    expect((await errorOf(store.get({ key: 'seg/a' }))).kind).toBe('network')
    fake.offline = false
    expect(await store.get({ key: 'seg/a' })).toEqual(enc.encode('a'))
    expect(store.pending).toBe(0)
  })

  test('a re-put of a known object after a failed flush still retries the flush', async () => {
    const { fake, store } = setup()
    await store.put('seg/a', enc.encode('a'))
    await store.flush()
    await store.put('seg/b', enc.encode('b'))
    fake.offline = true
    await errorOf(store.flush())
    expect((await errorOf(store.put('seg/a', enc.encode('a')))).kind).toBe('network')
    fake.offline = false
    await store.put('seg/a', enc.encode('a'))
    expect(fake.files().has('cursus/seg/b')).toBe(true)
  })

  test('another device moving the branch: rebuilt on its head without re-sending the content', async () => {
    const { fake, store } = setup()
    await store.put('seg/x', enc.encode('x'))
    fake.racePushes = 1
    await store.flush()
    expect(fake.text('elsewhere/1.txt')).toBe('push 1')
    expect(fake.text('cursus/seg/x')).toBe(toBase64(enc.encode('x')))
    expect(fake.count('PATCH ')).toBe(2)
    const trees = fake.bodies.filter((b) => b.call === 'POST /git/trees').map((b) => b.body.tree as object[])
    expect(trees).toHaveLength(2)
    expect(trees[0]?.[0]).toHaveProperty('content')
    expect(trees[1]?.[0]).not.toHaveProperty('content')
    expect(fake.forcedUpdates).toBe(0)
  })

  test('a branch that keeps moving fails after a bounded number of attempts, objects kept', async () => {
    const { fake, store } = setup({ maxRefRetries: 2 })
    await store.put('seg/x', enc.encode('x'))
    fake.racePushes = 10
    const e = await errorOf(store.flush())
    expect(e.kind).toBe('network')
    expect(fake.count('PATCH ')).toBe(3)
    expect(store.pending).toBe(1)
    expect(fake.forcedUpdates).toBe(0)
  })

  test('error mapping: bad token, rate limits, missing repository, server errors, quota, offline', async () => {
    const { fake, store, clock } = setup()
    fake.token = 'other'
    expect((await errorOf(keys(store.list('')))).kind).toBe('auth')
    fake.token = 'github_pat_test'

    fake.rateLimit = {
      remaining: 1,
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((T0 + 90_000) / 1000) },
      message: 'API rate limit exceeded',
    }
    let e = await errorOf(keys(store.list('')))
    expect(e.kind).toBe('rate-limited')
    expect(e.retryAfterMs).toBe(90_000 - (clock.now() - T0))

    fake.rateLimit = { remaining: 1, status: 429, headers: { 'retry-after': '30' }, message: 'slow down' }
    e = await errorOf(store.get({ key: 'x' }))
    expect(e).toMatchObject({ kind: 'rate-limited', retryAfterMs: 30_000 })

    fake.rateLimit = { remaining: 1, status: 403, headers: {}, message: 'You have exceeded a secondary rate limit' }
    e = await errorOf(keys(store.list('')))
    expect(e).toMatchObject({ kind: 'rate-limited', retryAfterMs: 60_000 })

    fake.rateLimit = {
      remaining: 1,
      status: 403,
      headers: {},
      message: 'Resource not accessible by personal access token',
    }
    expect((await errorOf(keys(store.list('')))).kind).toBe('permission')

    fake.failOn = { route: 'GET /git/ref', status: 503, remaining: 1 }
    expect((await errorOf(keys(store.list('')))).kind).toBe('network')

    await store.put('a', enc.encode('a'))
    fake.failOn = { route: 'POST /git/trees', status: 413, remaining: 1 }
    expect((await errorOf(store.flush())).kind).toBe('quota')
    await store.flush()

    fake.offline = true
    expect((await errorOf(keys(store.list('')))).kind).toBe('network')
    fake.offline = false

    fake.exists = false
    e = await errorOf(keys(store.list('')))
    expect(e.kind).toBe('permission')
    expect(e.message).toContain('not found, or the token cannot access it')
  })

  test('an unknown repository fails when resolving the default branch too', async () => {
    const fake = new FakeGitHub()
    fake.accessible = false
    const { store } = setup({ fake })
    expect((await errorOf(keys(store.list('')))).message).toContain('ada/notes not found')
    const named = setup({ fake, branch: 'main' }).store
    expect((await errorOf(keys(named.list('')))).kind).toBe('permission')
  })
})

describe('githubRemote: repository states', () => {
  test('an empty repository: reads write nothing; the first flush creates the README, then the commit', async () => {
    const fake = new FakeGitHub({ empty: true })
    const { store } = setup({ fake })
    expect(await keys(store.list(''))).toEqual([])
    expect(await store.get({ key: 'fmt/v1' })).toBeNull()
    expect(fake.writes).toBe(0)
    await store.put('fmt/v1', enc.encode('cursus/1\n'))
    expect(await keys(store.list(''))).toEqual(['fmt/v1'])
    expect(creating(fake)).toEqual([
      'PUT /contents/cursus/README.md',
      'POST /git/trees',
      'POST /git/commits',
      'PATCH /git/refs/heads/main',
    ])
    expect(fake.text('cursus/README.md')).toBe(README_TEXT)
    expect(await store.get({ key: 'README.md' })).toBeNull()
    expect(fake.messages.every((m) => /^Cursus backup: /.test(m))).toBe(true)
  })

  test('two devices bootstrapping the same empty repository', async () => {
    const fake = new FakeGitHub({ empty: true })
    // Another device writes the README between this one reading the repository as empty and writing it.
    const racing: Fetch = (url, init) => {
      if (url.includes('/contents/'))
        fake.commitFiles({ 'cursus/README.md': README_TEXT }, 'main', 'Cursus backup: README')
      return fake.fetch(url, init)
    }
    const { store } = setup({ fake, fetch: racing })
    await store.put('seg/a', enc.encode('a'))
    expect(await keys(store.list(''))).toEqual(['seg/a'])
    expect(fake.count('PUT /contents/')).toBe(1)
    expect(fake.count('POST /git/commits')).toBe(1)
  })

  test('a configured branch that does not exist starts from the default branch on the first write', async () => {
    const { fake, store } = setup({ branch: 'cursus-sync' })
    expect(await keys(store.list(''))).toEqual([])
    expect(fake.writes).toBe(0)
    await store.put('seg/a', enc.encode('a'))
    await store.flush()
    expect(fake.count('POST /git/refs')).toBe(1)
    expect(fake.files('cursus-sync').has('README.md')).toBe(true)
    expect(fake.files('cursus-sync').has('cursus/seg/a')).toBe(true)
    expect(fake.files('main').has('cursus/seg/a')).toBe(false)
  })

  test('a configured branch of an empty repository is created by the first commit', async () => {
    const fake = new FakeGitHub({ empty: true })
    const { store } = setup({ fake, branch: 'backup' })
    await store.put('seg/a', enc.encode('a'))
    await store.flush()
    expect(fake.files('backup').has('cursus/seg/a')).toBe(true)
  })

  test('truncated tree listings fall back to walking the folders', async () => {
    const fake = new FakeGitHub()
    fake.commitFiles({ 'docs/a.md': 'a', 'docs/b.md': 'b', 'src/x.ts': 'x' })
    const { store } = setup({ fake, root: 'deep/cursus' })
    const ks = ['seg/a/1', 'seg/a/2', 'seg/b/1', 'ckpt/a/1', 'fmt/v1']
    for (const k of ks) await store.put(k, enc.encode(k))
    await store.flush()
    fake.truncateAt = 3
    const other = setup({ fake, root: 'deep/cursus' }).store
    expect(await keys(other.list(''))).toEqual([...ks].sort())
    expect(fake.calls.some((c) => /^GET \/git\/trees\/[0-9a-f]+$/.test(c))).toBe(true)
    // A folder that does not exist yet lists nothing.
    expect(await keys(setup({ fake, root: 'deep/none' }).store.list(''))).toEqual([])
    expect(await keys(setup({ fake, root: 'nothing' }).store.list(''))).toEqual([])
  })
})

describe('githubRemote: objects', () => {
  test('an existing immutable key is never rewritten; mirror/ is', async () => {
    const { fake, store } = setup()
    await store.put('seg/x', enc.encode('one'))
    await store.put('mirror/a.md', enc.encode('v1'))
    await store.flush()
    const writes = fake.writes
    await store.put('seg/x', enc.encode('one'))
    await store.put('seg/x', enc.encode('two'))
    await store.put('mirror/a.md', enc.encode('v1'))
    expect(store.pending).toBe(0)
    await store.flush()
    expect(fake.writes).toBe(writes)
    await store.put('mirror/a.md', enc.encode('v2'))
    await store.flush()
    expect(fake.text('mirror/a.md')).toBeUndefined()
    expect(dec.decode(fromBase64(fake.text('cursus/mirror/a.md') ?? ''))).toBe('v2')
    expect(dec.decode(fromBase64(fake.text('cursus/seg/x') ?? ''))).toBe('one')
    // A device that has not listed yet stages the object; the flush finds it there and writes nothing.
    const other = setup({ fake }).store
    await other.put('seg/x', enc.encode('three'))
    expect(other.pending).toBe(1)
    const w2 = fake.writes
    await other.flush()
    expect(fake.writes).toBe(w2)
    expect(await other.get({ key: 'seg/x' })).toEqual(enc.encode('one'))
    // A staged mirror version replaced by the one already there is dropped.
    await store.put('mirror/a.md', enc.encode('v3'))
    await store.put('mirror/a.md', enc.encode('v2'))
    expect(store.pending).toBe(0)
  })

  test('binary data round-trips through base64 text, every byte value, by key and by handle', async () => {
    const { fake, store } = setup()
    const all = new Uint8Array(256 * 3).map((_, i) => i % 256)
    await store.put('blob/ab/cd', all)
    const listed: { key: string; handle?: string }[] = []
    for await (const x of store.list('blob/')) listed.push(x)
    expect(listed[0]?.handle).toBe(gitBlobSha(toBase64(all)))
    expect(await store.get(listed[0] as { key: string })).toEqual(all)
    expect(await store.get({ key: 'blob/ab/cd' })).toEqual(all)
    const stored = fake.files().get('cursus/blob/ab/cd') as Uint8Array
    expect(stored.every((b) => b < 128)).toBe(true)
    expect(stored.length).toBe(Math.ceil(all.length / 3) * 4)
    expect(fromBase64(toBase64(new Uint8Array()))).toEqual(new Uint8Array())
  })

  test('blobs answered as JSON are decoded too', async () => {
    const fake = new FakeGitHub()
    const json: Fetch = (url, init) =>
      fake.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Accept: 'application/json' } })
    const { store } = setup({ fake, fetch: json })
    const body = new Uint8Array(200).map((_, i) => 255 - i)
    await store.put('chunk/x', body)
    expect(await store.get({ key: 'chunk/x' })).toEqual(body)
  })

  test('a stale handle is null; a file edited outside Cursus is returned as is', async () => {
    const { fake, store } = setup()
    await store.put('seg/x', enc.encode('x'))
    await store.flush()
    expect(await store.get({ key: 'seg/x', handle: '0'.repeat(40) })).toBeNull()
    fake.commitFiles({ 'cursus/seg/y': 'not base64 !' })
    expect(await store.get({ key: 'seg/y' })).toEqual(enc.encode('not base64 !'))
    fake.offline = true
    expect((await errorOf(store.get({ key: 'seg/x', handle: '0'.repeat(40) }))).kind).toBe('network')
  })

  test('a listed object that cannot be read is an error, not an absence', async () => {
    const { fake, store } = setup()
    await store.put('seg/x', enc.encode('x'))
    await store.flush()
    fake.failOn = { route: 'GET /git/blobs/', status: 404, remaining: 1 }
    expect((await errorOf(store.get({ key: 'seg/x' }))).kind).toBe('network')
    fake.failOn = { route: 'GET /git/blobs/', status: 500, remaining: 1 }
    expect((await errorOf(store.get({ key: 'seg/x' }))).kind).toBe('network')
  })

  test('nothing is ever deleted or force-pushed', async () => {
    const { fake, store } = setup()
    for (const k of ['seg/a', 'mirror/x.md', 'mirror/y.md']) await store.put(k, enc.encode(k))
    await store.flush()
    await store.put('mirror/x.md', enc.encode('changed'))
    fake.racePushes = 1
    await store.flush()
    expect(fake.deletions).toBe(0)
    expect(fake.forcedUpdates).toBe(0)
    expect(fake.calls.some((c) => c.startsWith('DELETE '))).toBe(false)
    for (const { body } of fake.bodies) {
      if (Array.isArray(body.tree)) for (const item of body.tree as { sha?: unknown }[]) expect(item.sha).not.toBeNull()
      if ('force' in body) expect(body.force).toBe(false)
    }
    expect([...fake.files().keys()].filter((p) => p.startsWith('cursus/')).sort()).toEqual([
      'cursus/mirror/x.md',
      'cursus/mirror/y.md',
      'cursus/seg/a',
    ])
  })

  test('requests carry the token, the API version and the JSON media type, no custom User-Agent', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fake = new FakeGitHub()
    const { store } = setup({
      fake,
      fetch: (url, init) => {
        seen.push({ url, init })
        return fake.fetch(url, init)
      },
    })
    await store.put('seg/a', enc.encode('a'))
    await keys(store.list(''))
    for (const { url, init } of seen) {
      expect(url.startsWith('https://api.github.com/repos/ada/notes')).toBe(true)
      const h = init.headers as Record<string, string>
      expect(h.Authorization).toBe(`Bearer ${fake.token}`)
      expect(h['X-GitHub-Api-Version']).toBe('2022-11-28')
      expect(h.Accept).toBe('application/vnd.github+json')
      expect(Object.keys(h).some((k) => k.toLowerCase() === 'user-agent')).toBe(false)
    }
    expect(seen.find((s) => s.url.endsWith('/git/ref/heads/main'))?.init.cache).toBe('no-store')
    expect(store.incremental).toBe('none')
  })
})

describe('githubDestinationId', () => {
  test('same owner, repository, branch and folder: same destination; any change: another one', () => {
    const id = githubDestinationId({ owner: 'Ada', repo: 'Notes', root: '/cursus/' })
    expect(id).toMatch(/^github-[0-9a-f]{16}$/)
    expect(githubDestinationId({ owner: 'ada', repo: 'notes' })).toBe(id)
    expect(githubDestinationId({ owner: 'ada', repo: 'notes', root: '' })).toBe(id)
    expect(githubDestinationId({ owner: 'ada', repo: 'notes', root: 'other' })).not.toBe(id)
    expect(githubDestinationId({ owner: 'ada', repo: 'notes', branch: 'sync' })).not.toBe(id)
    expect(githubDestinationId({ owner: 'ada', repo: 'other' })).not.toBe(id)
    expect(setup().store.id).toBe(id)
  })
})

describe('checkGitHub', () => {
  const check = (fake: FakeGitHub, token = fake.token) =>
    checkGitHub({ owner: fake.owner, repo: fake.repo, token, fetch: fake.fetch, now: () => T0 })

  test('ok with the default branch; each failure has its reason', async () => {
    const fake = new FakeGitHub()
    expect(await check(fake)).toEqual({ ok: true, defaultBranch: 'main', private: true })
    expect(fake.writes).toBe(0)
    expect(await check(fake, 'bad')).toMatchObject({ ok: false, problem: 'token' })
    fake.permissions.push = false
    expect(await check(fake)).toMatchObject({ ok: false, problem: 'read-only' })
    fake.permissions.push = true
    fake.archived = true
    expect(await check(fake)).toMatchObject({ ok: false, problem: 'read-only' })
    fake.archived = false
    fake.accessible = false
    expect(await check(fake)).toMatchObject({ ok: false, problem: 'no-access' })
    fake.users.clear()
    expect(await check(fake)).toMatchObject({ ok: false, problem: 'not-found' })
    fake.accessible = true
    fake.rateLimit = { remaining: 1, status: 429, headers: { 'retry-after': '5' }, message: 'slow' }
    expect(await check(fake)).toEqual({
      ok: false,
      problem: 'rate-limited',
      detail: expect.any(String),
      retryAfterMs: 5000,
    })
    fake.offline = true
    expect(await check(fake)).toMatchObject({ ok: false, problem: 'network' })
  })

  test('a failure while checking the owner is reported', async () => {
    const fake = new FakeGitHub()
    fake.accessible = false
    fake.failOn = { route: 'GET /users/', status: 500, remaining: 1 }
    expect(await check(fake)).toMatchObject({ ok: false, problem: 'network' })
    fake.failOn = { route: 'GET ', status: 403, remaining: 1 }
    fake.accessible = true
    expect(await check(fake)).toMatchObject({ ok: false, problem: 'no-access' })
  })
})
