import { describe, expect, test } from 'bun:test'
import { FakeCloudKit } from '../../../../tests/support/fakeCloudKit'
import { RemoteError } from '../../contracts/errors'
import type { Entry } from '../../contracts/remote'
import {
  ASSET_THRESHOLD,
  cloudkitError,
  cloudkitRemote,
  fromBase64,
  MAX_OBJECT,
  recordNameOf,
  toBase64,
} from './cloudkit'
import { cloudkitAuth, cloudkitSecretName } from './cloudkitAuth'

const CONTAINER = 'iCloud.io.github.cursus'

function setup(o: { token?: string | null } = {}) {
  const fake = new FakeCloudKit()
  const invalidated: number[] = []
  const token = o.token === undefined ? 'user-token' : o.token
  const store = cloudkitRemote({
    container: CONTAINER,
    apiToken: fake.apiToken,
    auth: { token: async () => token, invalidate: async () => void invalidated.push(1) },
    endpoint: `${fake.origin}/`,
    fetch: fake.fetch,
  })
  return { fake, store, invalidated }
}

async function all(it: AsyncIterable<Entry>): Promise<Entry[]> {
  const out: Entry[] = []
  for await (const e of it) out.push(e)
  return out
}

async function rejection(p: Promise<unknown>): Promise<RemoteError> {
  try {
    await p
  } catch (e) {
    if (e instanceof RemoteError) return e
    throw e
  }
  throw new Error('expected a rejection')
}

function vault() {
  const m = new Map<string, unknown>()
  return {
    m,
    get: async <T>(n: string) => m.get(n) as T | undefined,
    set: async (n: string, v: unknown) => void m.set(n, v),
    delete: async (n: string) => void m.delete(n),
  }
}

describe('cloudkit remote', () => {
  test('id depends on container and environment', () => {
    const a = setup().store.id
    const b = cloudkitRemote({
      container: CONTAINER,
      environment: 'development',
      apiToken: 'x',
      auth: { token: async () => null, invalidate: async () => {} },
      fetch: async () => new Response(),
    }).id
    expect(a).toStartWith('cloudkit-')
    expect(a).not.toBe(b)
  })

  test('base64 round-trips every byte value and large buffers', () => {
    const b = new Uint8Array(100_000).map((_, i) => i % 256)
    expect(fromBase64(toBase64(b))).toEqual(b)
    expect(toBase64(new Uint8Array())).toBe('')
  })

  test('small bodies are inline BYTES, large ones go through an Asset', async () => {
    const { fake, store } = setup()
    await store.put('seg/a/small', new Uint8Array([1, 2, 3]))
    const big = new Uint8Array(ASSET_THRESHOLD + 1).map((_, i) => i % 251)
    await store.put('seg/a/big', big)
    const small = fake.records.get(recordNameOf('seg/a/small'))
    expect(small?.fields.data?.type).toBe('BYTES')
    expect(small?.fields.size?.value).toBe(3)
    expect(fake.records.get(recordNameOf('seg/a/big'))?.fields.asset).toBeDefined()
    expect(fake.requests.filter((r) => r.endsWith('assets/upload'))).toHaveLength(1)
    expect(await store.get({ key: 'seg/a/big' })).toEqual(big)
    const listed = await all(store.list('seg/'))
    expect(listed.map((e) => [e.key, e.size])).toEqual([
      ['seg/a/big', big.length],
      ['seg/a/small', 3],
    ])
  })

  test('above 50 MB is refused before any request', async () => {
    const { fake, store } = setup()
    const e = await rejection(store.put('seg/huge', new Uint8Array(MAX_OBJECT + 1)))
    expect(e.kind).toBe('quota')
    expect(fake.requests).toEqual([])
  })

  test('no token: auth error without calling the server', async () => {
    const { fake, store } = setup({ token: null })
    expect((await rejection(store.get({ key: 'x' }))).kind).toBe('auth')
    expect(fake.requests).toEqual([])
  })

  test('AUTHENTICATION_REQUIRED maps to auth and drops the token', async () => {
    const { store, invalidated } = setup({ token: 'expired' })
    expect((await rejection(store.put('k', new Uint8Array()))).kind).toBe('auth')
    expect(invalidated).toHaveLength(1)
  })

  test('HTTP errors map to RemoteError kinds with retryAfter', async () => {
    const { fake, store } = setup()
    fake.faults.push(
      { status: 503, serverErrorCode: 'TRY_AGAIN_LATER', retryAfter: 3 },
      { status: 403, serverErrorCode: 'ACCESS_DENIED' },
      { status: 413, serverErrorCode: 'QUOTA_EXCEEDED' },
      { status: 500 },
    )
    const r = await rejection(store.get({ key: 'k' }))
    expect([r.kind, r.retryAfterMs]).toEqual(['rate-limited', 3000])
    expect((await rejection(store.get({ key: 'k' }))).kind).toBe('permission')
    expect((await rejection(store.put('k', new Uint8Array()))).kind).toBe('quota')
    expect((await rejection(all(store.list('')))).kind).toBe('network')
  })

  test('per-record errors in a 200 response are errors, never "absent"', async () => {
    const { fake, store, invalidated } = setup()
    await store.put('k', new Uint8Array([1]))
    fake.faults.push(
      { status: 200, perRecord: true, serverErrorCode: 'THROTTLED' },
      { status: 200, perRecord: true, serverErrorCode: 'QUOTA_EXCEEDED' },
      { status: 200, perRecord: true, serverErrorCode: 'AUTHENTICATION_REQUIRED' },
    )
    expect((await rejection(store.get({ key: 'k' }))).kind).toBe('rate-limited')
    expect((await rejection(store.put('k', new Uint8Array()))).kind).toBe('quota')
    expect((await rejection(all(store.list('')))).kind).toBe('auth')
    expect(invalidated).toHaveLength(1)
  })

  test('checksum mismatch and broken asset downloads are network errors', async () => {
    const { fake, store } = setup()
    await store.put('k', new Uint8Array([1, 2]))
    const rec = fake.records.get(recordNameOf('k'))
    if (rec) rec.fields.data = { value: toBase64(new Uint8Array([9])), type: 'BYTES' }
    expect((await rejection(store.get({ key: 'k' }))).kind).toBe('network')
    await store.put('big', new Uint8Array(ASSET_THRESHOLD + 10))
    fake.blobs.clear()
    expect((await rejection(store.get({ key: 'big' }))).kind).toBe('network')
  })

  test('unreadable bodies and odd responses are errors', async () => {
    const mk = (fetchFn: (url: string) => Promise<Response>) =>
      cloudkitRemote({
        container: CONTAINER,
        apiToken: 'a',
        auth: { token: async () => 't', invalidate: async () => {} },
        fetch: fetchFn,
      })
    const html = mk(async () => new Response('<html>', { status: 429 }))
    expect((await rejection(html.get({ key: 'k' }))).kind).toBe('rate-limited')
    const garbage = mk(async () => new Response('nope', { status: 502 }))
    expect((await rejection(garbage.get({ key: 'k' }))).kind).toBe('network')
    const empty = mk(async () => Response.json({ records: [] }))
    expect(await empty.get({ key: 'k' })).toBeNull()
    expect((await rejection(empty.put('k', new Uint8Array()))).kind).toBe('network')
    const noUrl = mk(async () => Response.json({ tokens: [] }))
    expect((await rejection(noUrl.put('k', new Uint8Array(ASSET_THRESHOLD + 1)))).kind).toBe('network')
    const badUpload = mk(async (url) =>
      url.includes('assets/upload') ? Response.json({ tokens: [{ url: 'http://u' }] }) : new Response('x'),
    )
    expect((await rejection(badUpload.put('k', new Uint8Array(ASSET_THRESHOLD + 1)))).kind).toBe('network')
    const refused = mk(async (url) =>
      url.includes('assets/upload')
        ? Response.json({ tokens: [{ url: 'http://u' }] })
        : Response.json({ serverErrorCode: 'QUOTA_EXCEEDED' }, { status: 413 }),
    )
    expect((await rejection(refused.put('k', new Uint8Array(ASSET_THRESHOLD + 1)))).kind).toBe('quota')
  })

  test('cloudkitError keeps the reason and defaults unknown codes to network', () => {
    const e = cloudkitError(400, { serverErrorCode: 'BAD_REQUEST', reason: 'oops' }, 'op')
    expect([e.kind, e.message, e.retryAfterMs]).toEqual(['network', 'op: BAD_REQUEST (oops)', undefined])
    expect(cloudkitError(401, {}, 'op').kind).toBe('auth')
  })
})

describe('cloudkit auth', () => {
  function auth(fake = new FakeCloudKit(), params?: Record<string, string>) {
    const secrets = vault()
    let pending = params
    const a = cloudkitAuth({
      container: CONTAINER,
      apiToken: fake.apiToken,
      secrets,
      takeCallbackParams: async () => {
        const p = pending
        pending = undefined
        return p
      },
      endpoint: fake.origin,
      fetch: fake.fetch,
    })
    return { a, secrets, fake }
  }
  const name = cloudkitSecretName(CONTAINER, 'production')

  test('not signed in: signInUrl returns Apple redirectURL', async () => {
    const { a } = auth()
    expect(await a.token()).toBeNull()
    expect(await a.signInUrl()).toBe('https://idmsa.apple.com/signin?x=1')
  })

  test('the callback token moves into the vault once and stays there', async () => {
    const { a, secrets } = auth(undefined, { ckWebAuthToken: 'user-token' })
    expect(await a.token()).toBe('user-token')
    expect(secrets.m.get(name)).toBe('user-token')
    expect(await a.token()).toBe('user-token')
    expect(await a.signInUrl()).toBeNull()
    await a.signOut()
    expect(await a.token()).toBeNull()
  })

  test('callback without token is ignored', async () => {
    const { a } = auth(undefined, { error: 'cancelled' })
    expect(await a.token()).toBeNull()
  })

  test('an expired stored token is dropped when Apple asks to sign in again', async () => {
    const { a, secrets } = auth()
    await secrets.set(name, 'expired')
    expect(await a.signInUrl()).toStartWith('https://idmsa.apple.com')
    expect(secrets.m.has(name)).toBe(false)
    await secrets.set(name, 'x')
    await a.invalidate()
    expect(secrets.m.has(name)).toBe(false)
  })

  test('bad API token and network failures are errors', async () => {
    const fake = new FakeCloudKit()
    fake.apiToken = 'other'
    const { a } = auth(fake)
    fake.apiToken = 'changed'
    expect((await rejection(a.signInUrl())).kind).toBe('permission')
    const down = cloudkitAuth({
      container: CONTAINER,
      environment: 'development',
      apiToken: 'a',
      secrets: vault(),
      takeCallbackParams: async () => undefined,
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect((await rejection(down.signInUrl())).kind).toBe('network')
    const broken = cloudkitAuth({
      container: CONTAINER,
      apiToken: 'a',
      secrets: vault(),
      takeCallbackParams: async () => undefined,
      fetch: async () => new Response('x', { status: 500 }),
    })
    expect((await rejection(broken.signInUrl())).kind).toBe('network')
  })
})
