import { describe, expect, test } from 'bun:test'
import { FakeOneDrive } from '../../../../tests/support/fakeOneDrive'
import { RemoteError } from '../../contracts/remote'
import { virtualClock } from '../../ports/clock'
import { memoryStore } from '../../storage/memoryStore'
import { secretsVault } from '../../storage/secrets'
import { FRAGMENT, onedriveRemote } from './onedrive'
import {
  beginOneDrive,
  finishOneDrive,
  MS_AUTHORITY,
  ONEDRIVE_SECRET,
  type OneDriveTokens,
  onedriveAuthorizeUrl,
  onedrivePendingName,
  onedriveSession,
} from './onedriveAuth'

const enc = new TextEncoder()
const GRAPH = 'https://graph.test'
const AUTHORITY = 'https://graph.test/oauth'

function setup(o: { maxRetries?: number; uploadLimit?: number; chunkSize?: number; root?: string } = {}) {
  const clock = virtualClock(1_700_000_000_000)
  const fake = new FakeOneDrive(() => clock.now())
  const sleeps: number[] = []
  const store = onedriveRemote({
    fetch: fake.fetch,
    tokens: { token: async () => fake.accessToken, refresh: async () => fake.accessToken },
    root: o.root ?? 'app',
    graphBase: GRAPH,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...(o.maxRetries !== undefined ? { maxRetries: o.maxRetries } : {}),
    ...(o.uploadLimit !== undefined ? { uploadLimit: o.uploadLimit } : {}),
    ...(o.chunkSize !== undefined ? { chunkSize: o.chunkSize } : {}),
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

describe('onedriveRemote', () => {
  test('writes under the app folder, by path, replacing what is there', async () => {
    const { fake, store } = setup()
    await store.put('seg/d/1', enc.encode('a'))
    await store.put('seg/d/1', enc.encode('b'))
    expect(new TextDecoder().decode(fake.nodes.get('app/seg/d/1')?.bytes)).toBe('b')
    expect(fake.calls).toContain('PUT /me/drive/special/approot:/app/seg/d/1:/content')
    expect(store.id).toMatch(/^onedrive-[0-9a-f]{16}$/)
    expect(setup({ root: 'other' }).store.id).not.toBe(store.id)
  })

  test('lists every page of every folder, in key order, skipping folders off the prefix', async () => {
    const { fake, store } = setup()
    for (let i = 0; i < 5; i++) await store.put(`seg/d${i % 2}/${i}`, enc.encode('x'))
    await store.put('ckpt/x', enc.encode('c'))
    fake.calls.length = 0
    expect(await keys(store.list('seg/', { pageSize: 2 }))).toEqual([
      'seg/d0/0',
      'seg/d0/2',
      'seg/d0/4',
      'seg/d1/1',
      'seg/d1/3',
    ])
    expect(fake.calls.some((c) => c.includes('ckpt'))).toBe(false)
    expect(await keys(store.list('seg/d1'))).toEqual(['seg/d1/1', 'seg/d1/3'])
    expect(await keys(store.list(''))).toHaveLength(6)
    expect(await keys(store.list('', { createdAfter: Number.MAX_SAFE_INTEGER }))).toHaveLength(6)
  })

  test('a folder that is missing lists nothing; a missing file reads as null by path and by handle', async () => {
    const { store } = setup()
    expect(await keys(store.list('seg/'))).toEqual([])
    expect(await store.get({ key: 'seg/none' })).toBeNull()
    expect(await store.get({ key: 'seg/none', handle: 'item-404' })).toBeNull()
  })

  test('a 401 refreshes the token once, then is an auth error', async () => {
    const fake = new FakeOneDrive()
    let refreshes = 0
    const store = onedriveRemote({
      fetch: fake.fetch,
      graphBase: GRAPH,
      tokens: {
        token: async () => 'stale',
        refresh: async () => {
          refreshes++
          return 'stale'
        },
      },
    })
    const e = await errorOf(store.put('a', enc.encode('x')))
    expect(e.kind).toBe('auth')
    expect(refreshes).toBe(1)
  })

  test('429 and 5xx are retried after Retry-After, then surface', async () => {
    const { fake, store, sleeps } = setup({ maxRetries: 2 })
    fake.rateLimit = { remaining: 2, retryAfter: 3, status: 429 }
    await store.put('a', enc.encode('x'))
    expect(sleeps).toEqual([3000, 3000])
    fake.rateLimit = { remaining: 5, retryAfter: 1, status: 429 }
    const limited = await errorOf(store.put('a', enc.encode('x')))
    expect(limited.kind).toBe('rate-limited')
    expect(limited.retryAfterMs).toBe(1000)
    fake.rateLimit = { remaining: 5, retryAfter: 0, status: 503 }
    sleeps.length = 0
    expect((await errorOf(store.put('a', enc.encode('x')))).kind).toBe('network')
    expect(sleeps).toEqual([500, 1000])
  })

  test('storage full is a quota error; a refused request is a permission error; no network is network', async () => {
    const { fake, store } = setup()
    fake.full = true
    expect((await errorOf(store.put('a', enc.encode('x')))).kind).toBe('quota')
    fake.full = false
    fake.deny = true
    expect((await errorOf(store.get({ key: 'a' }))).kind).toBe('permission')
    fake.offline = true
    expect((await errorOf(store.get({ key: 'a' }))).kind).toBe('network')
  })

  test('large bodies go through an upload session, in ordered ranges, without the bearer token', async () => {
    const { fake, store } = setup({ uploadLimit: 4, chunkSize: 4 })
    const body = enc.encode('0123456789')
    await store.put('big/file', body)
    expect(fake.nodes.get('app/big/file')?.bytes).toEqual(body)
    expect(fake.uploadAuth).toEqual([])
    expect(fake.calls.filter((c) => c.startsWith('PUT /upload/'))).toHaveLength(3)
    expect(FRAGMENT % 1024).toBe(0)
  })
})

describe('onedrive auth', () => {
  const clientId = 'client-id'
  const redirectUri = 'https://app.test/cursus/oauth-callback.html'

  test('the authorize URL asks for the app folder and offline access with PKCE, at the common authority', () => {
    const url = new URL(onedriveAuthorizeUrl({ clientId, redirectUri, challenge: 'ch', state: 'st' }))
    expect(`${url.origin}${url.pathname}`).toBe(`${MS_AUTHORITY}/authorize`)
    expect(url.searchParams.get('scope')).toBe('Files.ReadWrite.AppFolder offline_access')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri)
  })

  async function connect() {
    const clock = virtualClock(1_700_000_000_000)
    const fake = new FakeOneDrive(() => clock.now())
    const secrets = secretsVault(memoryStore())
    let sealed = 0
    const url = new URL(
      await beginOneDrive({
        clientId,
        redirectUri,
        secrets,
        name: 'onedrive:root',
        authority: AUTHORITY,
        seal: async () => {
          sealed++
        },
      }),
    )
    const state = url.searchParams.get('state') ?? ''
    const pending = await secrets.get<{ verifier: string }>(onedrivePendingName(state))
    fake.grant('code-1', pending?.verifier ?? '')
    const base = { fetch: fake.fetch, clientId, secrets, clock, authority: AUTHORITY }
    return { clock, fake, secrets, state, base, sealed: () => sealed, url }
  }

  test('begin seals and remembers the verifier; finish exchanges the code and stores the tokens', async () => {
    const { fake, secrets, state, base, sealed, url } = await connect()
    expect(sealed()).toBe(1)
    expect(url.href.startsWith(`${AUTHORITY}/authorize?`)).toBe(true)
    expect(await finishOneDrive({ ...base, params: { code: 'code-1', state } })).toBe('onedrive:root')
    const t = await secrets.get<OneDriveTokens>('onedrive:root')
    expect(t?.accessToken).toBe(fake.accessToken)
    expect(t?.refreshToken).toBe(fake.refreshToken)
    expect(await secrets.get(onedrivePendingName(state))).toBeUndefined()
  })

  test('finish refuses a missing state, an unknown state, a provider error and a missing code', async () => {
    const { state, base } = await connect()
    expect((await errorOf(finishOneDrive({ ...base, params: {} }))).kind).toBe('auth')
    expect((await errorOf(finishOneDrive({ ...base, params: { state: 'other', code: 'x' } }))).kind).toBe('auth')
    const denied = await errorOf(finishOneDrive({ ...base, params: { state, error: 'access_denied' } }))
    expect(denied.message).toContain('access_denied')
    const again = await connect()
    expect((await errorOf(finishOneDrive({ ...again.base, params: { state: again.state } }))).kind).toBe('auth')
    const wrong = await connect()
    const refused = await errorOf(finishOneDrive({ ...wrong.base, params: { state: wrong.state, code: 'bad' } }))
    expect(refused.kind).toBe('auth')
  })

  test('the session refreshes before expiry, keeps the rotated refresh token, and coalesces refreshes', async () => {
    const { clock, fake, secrets, state, base } = await connect()
    await finishOneDrive({ ...base, params: { code: 'code-1', state } })
    const tokens = onedriveSession({ ...base, name: 'onedrive:root' })
    const first = await tokens.token()
    expect(first).toBe(fake.accessToken)
    clock.advance(3600_000)
    const [a, b] = await Promise.all([tokens.token(), tokens.refresh()])
    expect(a).toBe(b)
    expect(fake.refreshes).toHaveLength(1)
    expect((await secrets.get<OneDriveTokens>('onedrive:root'))?.refreshToken).toBe(fake.refreshToken)
    expect(await tokens.token()).toBe(fake.accessToken)
  })

  test('an expired refresh token (24 h for single-page apps) is an auth error: the destination asks to sign in', async () => {
    const { fake, state, base } = await connect()
    await finishOneDrive({ ...base, params: { code: 'code-1', state } })
    fake.refreshExpired = true
    const tokens = onedriveSession({ ...base, name: 'onedrive:root' })
    const e = await errorOf(tokens.refresh())
    expect(e.kind).toBe('auth')
    expect(e.message).toContain('invalid_grant')
  })

  test('not connected, token endpoint failures and a grant without offline access are errors', async () => {
    const clock = virtualClock(0)
    const secrets = secretsVault(memoryStore())
    const respond = (status: number, body: string) => async () => new Response(body, { status })
    expect((await errorOf(onedriveSession({ fetch: respond(200, '{}'), clientId, secrets, clock }).token())).kind).toBe(
      'auth',
    )
    await secrets.set(ONEDRIVE_SECRET, { accessToken: 'a', refreshToken: 'r', expiresAt: 0 })
    const kinds: string[] = []
    for (const fetch of [
      respond(429, ''),
      respond(500, 'down'),
      async () => {
        throw new TypeError('offline')
      },
    ])
      kinds.push((await errorOf(onedriveSession({ fetch, clientId, secrets, clock }).token())).kind)
    expect(kinds).toEqual(['rate-limited', 'network', 'network'])
    // A refresh that returns no new refresh token keeps the old one.
    const kept = onedriveSession({
      fetch: respond(200, '{"access_token":"n","expires_in":60}'),
      clientId,
      secrets,
      clock,
    })
    expect(await kept.token()).toBe('n')
    expect((await secrets.get<OneDriveTokens>(ONEDRIVE_SECRET))?.refreshToken).toBe('r')
    // An authorization that grants no refresh token cannot sync in the background.
    const fresh = secretsVault(memoryStore())
    const url = new URL(await beginOneDrive({ clientId, redirectUri, secrets: fresh, seal: async () => undefined }))
    const st = url.searchParams.get('state') ?? ''
    const e = await errorOf(
      finishOneDrive({
        fetch: respond(200, '{"access_token":"n"}'),
        clientId,
        secrets: fresh,
        clock,
        params: { state: st, code: 'c' },
      }),
    )
    expect(e.message).toContain('offline access')
  })
})
