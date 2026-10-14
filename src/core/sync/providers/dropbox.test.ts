import { describe, expect, test } from 'bun:test'
import { FakeDropbox } from '../../../../tests/support/fakeDropbox'
import { RemoteError } from '../../contracts/remote'
import { virtualClock } from '../../ports/clock'
import { memoryStore } from '../../storage/memoryStore'
import { secretsVault } from '../../storage/secrets'
import { apiArg, dropboxRemote } from './dropbox'
import * as auth from './dropboxAuth'
import { authorizeUrl, connectDropbox, createPkce, DROPBOX_SECRET, dropboxSession, exchangeCode } from './dropboxAuth'

const enc = new TextEncoder()

function setup(o: { maxRetries?: number } = {}) {
  const clock = virtualClock(1_700_000_000_000)
  const fake = new FakeDropbox(clock)
  const sleeps: number[] = []
  const store = dropboxRemote({
    fetch: fake.fetch,
    tokens: { token: async () => fake.accessToken, refresh: async () => fake.accessToken },
    clock,
    root: 'app',
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    maxRetries: o.maxRetries,
  })
  return { clock, fake, store, sleeps }
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

describe('dropboxRemote', () => {
  test('escapes non-ASCII characters of Dropbox-API-Arg', async () => {
    expect(apiArg({ path: '/é ü' })).toBe('{"path":"/\\u00e9 \\u00fc"}')
    const { fake, store } = setup()
    await store.put('mirror/Cours é.md', enc.encode('x'))
    expect(fake.argHeaders.every((h) => /^[\x20-\x7e]*$/.test(h))).toBe(true)
    expect(fake.files.get('/app/mirror/cours é.md')?.path).toBe('/app/mirror/Cours é.md')
  })

  test('the destination id depends on the account and folder', () => {
    const clock = virtualClock()
    const fake = new FakeDropbox(clock)
    const t = { token: async () => '', refresh: async () => '' }
    const a = dropboxRemote({ fetch: fake.fetch, tokens: t, clock, root: 'a', account: 'x' })
    const b = dropboxRemote({ fetch: fake.fetch, tokens: t, clock, root: '/a/', account: 'x' })
    const c = dropboxRemote({ fetch: fake.fetch, tokens: t, clock, root: 'a', account: 'y' })
    expect(a.id).toBe(b.id)
    expect(a.id).not.toBe(c.id)
    expect(a.id.startsWith('dropbox-')).toBe(true)
  })

  test('a 401 refreshes the token once, then retries', async () => {
    const clock = virtualClock(0)
    const fake = new FakeDropbox(clock)
    let current = 'stale'
    let refreshes = 0
    const store = dropboxRemote({
      fetch: fake.fetch,
      clock,
      tokens: {
        token: async () => current,
        refresh: async () => {
          refreshes++
          current = fake.accessToken
          return current
        },
      },
    })
    await store.put('k', enc.encode('v'))
    expect(refreshes).toBe(1)
    const stuck = dropboxRemote({
      fetch: fake.fetch,
      clock,
      tokens: { token: async () => 'revoked', refresh: async () => 'revoked' },
    })
    const e = await errorOf(stuck.get({ key: 'k' }))
    expect(e.kind).toBe('auth')
  })

  test('429 backs off with Retry-After, then succeeds', async () => {
    const { fake, store, sleeps } = setup()
    fake.rateLimit = { remaining: 2, retryAfter: 3 }
    await store.put('k', enc.encode('v'))
    expect(sleeps).toEqual([3000, 3000])
  })

  test('persistent 429 surfaces as rate-limited with the wait', async () => {
    const { fake, store, sleeps } = setup({ maxRetries: 2 })
    fake.rateLimit = { remaining: 10, retryAfter: 7 }
    const e = await errorOf(store.get({ key: 'k' }))
    expect(e.kind).toBe('rate-limited')
    expect(e.retryAfterMs).toBe(7000)
    expect(sleeps.length).toBe(2)
  })

  test('5xx backs off exponentially, then is a network error', async () => {
    const clock = virtualClock()
    const sleeps: number[] = []
    const store = dropboxRemote({
      fetch: async () => new Response('down', { status: 503 }),
      tokens: { token: async () => 't', refresh: async () => 't' },
      clock,
      maxRetries: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    const e = await errorOf(store.put('k', enc.encode('v')))
    expect(e.kind).toBe('network')
    expect(sleeps).toEqual([500, 1000, 2000])
  })

  test('maps 403 to permission, insufficient space to quota, other 409 to permission', async () => {
    const mk = (status: number, body: string) =>
      dropboxRemote({
        fetch: async () => new Response(body, { status }),
        tokens: { token: async () => 't', refresh: async () => 't' },
        clock: virtualClock(),
      })
    expect((await errorOf(mk(403, '{"error_summary":"no"}').put('k', new Uint8Array()))).kind).toBe('permission')
    expect((await errorOf(mk(409, 'not json').get({ key: 'k' }))).kind).toBe('permission')
    const { fake, store } = setup()
    fake.quotaBytes = 2
    expect((await errorOf(store.put('k', enc.encode('too big')))).kind).toBe('quota')
  })

  test('offline is a network error', async () => {
    const { fake, store } = setup()
    fake.offline = true
    expect((await errorOf(store.put('k', enc.encode('v')))).kind).toBe('network')
  })

  test('get by handle reads the file id', async () => {
    const { store } = setup()
    await store.put('seg/a', enc.encode('A'))
    const listed: { key: string; handle?: string }[] = []
    for await (const e of store.list('seg/')) listed.push(e)
    expect(listed[0]?.handle?.startsWith('id:')).toBe(true)
    expect(await store.get({ key: 'ignored', handle: listed[0]?.handle })).toEqual(enc.encode('A'))
  })

  test('large bodies go through an upload session in chunks', async () => {
    const clock = virtualClock()
    const fake = new FakeDropbox(clock)
    const store = dropboxRemote({
      fetch: fake.fetch,
      tokens: { token: async () => fake.accessToken, refresh: async () => fake.accessToken },
      clock,
      uploadLimit: 5,
      chunkSize: 4,
    })
    const body = enc.encode('0123456789abc')
    await store.put('big', body)
    expect(fake.calls.filter((c) => c.includes('upload_session'))).toEqual([
      '/2/files/upload_session/start',
      '/2/files/upload_session/append_v2',
      '/2/files/upload_session/append_v2',
      '/2/files/upload_session/finish',
    ])
    expect(await store.get({ key: 'big' })).toEqual(body)
  })

  test('a later createdAfter listing continues from the saved cursor', async () => {
    const { clock, fake, store } = setup()
    for (const k of ['seg/a', 'seg/b', 'seg/c', 'seg/d']) await store.put(k, enc.encode(k))
    expect(await keys(store.list('seg/'))).toEqual(['seg/a', 'seg/b', 'seg/c', 'seg/d'])
    const t = clock.now()
    clock.advance(1000)
    await store.put('seg/e', enc.encode('e'))
    fake.calls.length = 0
    expect(await keys(store.list('seg/', { createdAfter: t }))).toEqual(['seg/e'])
    expect(fake.calls).toEqual(['/2/files/list_folder/continue'])
    // Nothing new: the cursor answers with no file.
    expect(await keys(store.list('seg/', { createdAfter: clock.now() }))).toEqual([])
    // A createdAfter older than the cursor falls back to a full listing filtered by server time.
    expect(await keys(store.list('seg/', { createdAfter: t - 10_000 }))).toEqual([
      'seg/a',
      'seg/b',
      'seg/c',
      'seg/d',
      'seg/e',
    ])
  })
})

describe('dropboxAuth', () => {
  const clientId = 'app-key'
  const redirectUri = 'https://example.test/cursus/oauth-callback.html'

  test('PKCE challenge is the S256 of the verifier', async () => {
    const p = await createPkce()
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/)
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(p.verifier)))
    expect(p.challenge).toBe(Buffer.from(d).toString('base64url'))
  })

  test('authorize URL asks for offline access with S256 and no secret', () => {
    const u = new URL(authorizeUrl({ clientId, redirectUri, challenge: 'ch', state: 'st' }))
    expect(u.origin + u.pathname).toBe('https://www.dropbox.com/oauth2/authorize')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      state: 'st',
    })
  })

  test('connect: authorize, check state, exchange the code, store tokens; session refreshes without secret', async () => {
    const clock = virtualClock(1_000_000)
    const fake = new FakeDropbox(clock)
    const secrets = secretsVault(memoryStore())
    const tokens = await connectDropbox({
      fetch: fake.fetch,
      clientId,
      redirectUri,
      secrets,
      clock,
      authorize: async (url) => {
        const q = new URL(url).searchParams
        const state = q.get('state') ?? ''
        fake.grant('the-code', pendingVerifier)
        return { code: 'the-code', state }
      },
      random: (n) => {
        const b = new Uint8Array(n).fill(n)
        if (n === 48) pendingVerifier = Buffer.from(b).toString('base64url')
        return b
      },
    })
    expect(tokens.refreshToken).toBe('rt-0')
    expect(tokens.accountId).toBe('dbid:fake')
    expect(tokens.expiresAt).toBe(1_000_000 + 14_400_000)
    expect(await secrets.get(DROPBOX_SECRET)).toEqual(tokens)

    const session = dropboxSession({ fetch: fake.fetch, clientId, secrets, clock })
    expect(await session.token()).toBe(tokens.accessToken)
    clock.advance(14_400_000)
    const [a, b] = await Promise.all([session.token(), session.token()])
    expect(a).toBe(b)
    expect(a).toBe(fake.accessToken)
    expect(fake.refreshes.length).toBe(1)
    expect(await session.refresh()).toBe(fake.accessToken)
    expect(fake.refreshes.length).toBe(2)
  })

  test('connect rejects a state mismatch, an error, or a missing code', async () => {
    const clock = virtualClock()
    const fake = new FakeDropbox(clock)
    const base = { fetch: fake.fetch, clientId, redirectUri, secrets: secretsVault(memoryStore()), clock }
    expect((await errorOf(connectDropbox({ ...base, authorize: async () => ({ code: 'c', state: 'x' }) }))).kind).toBe(
      'auth',
    )
    expect((await errorOf(connectDropbox({ ...base, authorize: async () => ({ error: 'access_denied' }) }))).kind).toBe(
      'auth',
    )
    const noCode = connectDropbox({
      ...base,
      authorize: async (url) => ({ state: new URL(url).searchParams.get('state') ?? '' }),
    })
    expect((await errorOf(noCode)).kind).toBe('auth')
  })

  test('full-page redirect: begin seals and persists, a reload loses memory, finish completes from the store', async () => {
    const clock = virtualClock(5_000)
    const fake = new FakeDropbox(clock)
    const store = memoryStore()
    const events: string[] = []
    const url = await auth.beginDropbox({
      clientId,
      redirectUri,
      secrets: secretsVault(store),
      seal: async () => {
        events.push('seal')
      },
    })
    const q = new URL(url).searchParams
    const state = q.get('state') ?? ''
    expect(events).toEqual(['seal'])
    expect(q.get('client_id')).toBe(clientId)
    const pending = await secretsVault(store).get<{ verifier: string }>(auth.dropboxPendingName(state))
    if (!pending) throw new Error('nothing persisted before leaving')
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(pending.verifier)))
    expect(q.get('code_challenge')).toBe(Buffer.from(d).toString('base64url'))
    fake.grant('the-code', pending.verifier)

    // Reload: fresh module state, same store; oauth-callback.html stored { params, receivedAt } under oauth:<state>.
    const fresh: typeof auth = await import(`./dropboxAuth.ts?reload=${Date.now()}`)
    const secrets = secretsVault(store)
    const name = await fresh.finishDropbox({
      fetch: fake.fetch,
      clientId,
      secrets,
      clock,
      params: { code: 'the-code', state },
    })
    expect(name).toBe(DROPBOX_SECRET)
    const tokens = await secrets.get<{ refreshToken: string; expiresAt: number }>(DROPBOX_SECRET)
    expect(tokens?.refreshToken).toBe('rt-0')
    expect(tokens?.expiresAt).toBe(5_000 + 14_400_000)
    expect(await secrets.get(fresh.dropboxPendingName(state))).toBeUndefined()
    expect(
      (
        await errorOf(
          fresh.finishDropbox({ fetch: fake.fetch, clientId, secrets, clock, params: { code: 'the-code', state } }),
        )
      ).kind,
    ).toBe('auth')
  })

  test('finish rejects a missing state, an unknown state, a refusal, or a missing code', async () => {
    const clock = virtualClock()
    const fake = new FakeDropbox(clock)
    const secrets = secretsVault(memoryStore())
    const base = { fetch: fake.fetch, clientId, secrets, clock }
    const begin = async () =>
      new URL(
        await auth.beginDropbox({ clientId, redirectUri, secrets, name: 'dbx-2', seal: async () => {} }),
      ).searchParams.get('state') ?? ''
    expect((await errorOf(auth.finishDropbox({ ...base, params: { code: 'c' } }))).kind).toBe('auth')
    expect((await errorOf(auth.finishDropbox({ ...base, params: { code: 'c', state: 'nope' } }))).kind).toBe('auth')
    const s1 = await begin()
    expect((await errorOf(auth.finishDropbox({ ...base, params: { error: 'access_denied', state: s1 } }))).kind).toBe(
      'auth',
    )
    expect(await secrets.get(auth.dropboxPendingName(s1))).toBeUndefined()
    const s2 = await begin()
    expect((await errorOf(auth.finishDropbox({ ...base, params: { state: s2 } }))).kind).toBe('auth')
    expect(await secrets.get('dbx-2')).toBeUndefined()
  })

  test('token endpoint errors map to RemoteError kinds', async () => {
    const clock = virtualClock()
    const p = { clientId, redirectUri, verifier: 'v', code: 'c', clock }
    const fake = new FakeDropbox(clock)
    expect((await errorOf(exchangeCode({ ...p, fetch: fake.fetch }))).kind).toBe('auth')
    const status = (s: number) => async () => new Response('x', { status: s })
    expect((await errorOf(exchangeCode({ ...p, fetch: status(429) }))).kind).toBe('rate-limited')
    expect((await errorOf(exchangeCode({ ...p, fetch: status(500) }))).kind).toBe('network')
    const boom = async (): Promise<Response> => {
      throw new TypeError('offline')
    }
    expect((await errorOf(exchangeCode({ ...p, fetch: boom }))).kind).toBe('network')
    const online = async () => new Response('{"access_token":"a","expires_in":10}')
    expect((await errorOf(exchangeCode({ ...p, fetch: online }))).kind).toBe('auth')
  })

  test('a session without stored tokens is an auth error', async () => {
    const s = dropboxSession({ fetch: fetch, clientId, secrets: secretsVault(memoryStore()), clock: virtualClock() })
    expect((await errorOf(s.token())).kind).toBe('auth')
  })
})

let pendingVerifier = ''
