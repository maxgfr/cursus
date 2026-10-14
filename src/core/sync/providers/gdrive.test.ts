import { describe, expect, test } from 'bun:test'
import { FakeGoogle } from '../../../../tests/support/fakeGoogle'
import { RemoteError } from '../../contracts/errors'
import type { Entry } from '../../contracts/remote'
import { virtualClock } from '../../ports/clock'
import { memoryStore } from '../../storage/memoryStore'
import { secretsVault } from '../../storage/secrets'
import { type GDriveRemote, gdriveRemote, MULTIPART_MAX, multipart } from './gdrive'
import { type Fetch, gdriveTokens } from './gdriveAuth'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

async function all(it: AsyncIterable<Entry>): Promise<Entry[]> {
  const out: Entry[] = []
  for await (const e of it) out.push(e)
  return out
}

async function setup(o: { listDelayMs?: number; fetch?: (g: FakeGoogle) => Fetch; pageSize?: number } = {}) {
  const clock = virtualClock(Date.UTC(2026, 0, 1))
  const google = new FakeGoogle({ clock, clientSecret: 's', listDelayMs: o.listDelayMs })
  const secrets = secretsVault(memoryStore())
  await secrets.set('g', { clientId: google.clientId, clientSecret: 's', refreshToken: google.grant() })
  const fetch = o.fetch ? o.fetch(google) : google.fetch
  const device = (): GDriveRemote =>
    gdriveRemote({
      fetch,
      tokens: gdriveTokens({ fetch, clock, secrets, secretName: 'g' }),
      rootName: 'Cursus',
      pageSize: o.pageSize,
    })
  return { clock, google, store: device(), device }
}

async function kind(p: Promise<unknown>): Promise<RemoteError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  )
  expect(e).toBeInstanceOf(RemoteError)
  return e as RemoteError
}

describe('roots', () => {
  test('first write creates one visible root tagged cursusRoot=1; id is stable per root name', async () => {
    const { google, store, device } = await setup()
    expect(await store.roots()).toEqual([])
    expect(await all(store.list(''))).toEqual([])
    expect(await store.get({ key: 'fmt/v1' })).toBeNull()
    await store.put('fmt/v1', bytes('x'))
    const roots = [...google.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.folder')
    expect(roots.map((r) => [r.name, r.appProperties, r.parents])).toEqual([['Cursus', { cursusRoot: '1' }, ['root']]])
    expect(await device().roots()).toEqual([roots[0]?.id as string])
    expect(store.id).toBe(device().id)
    expect(store.id).toStartWith('gdrive-')
  })

  test('an untagged folder of the same name is not a root', async () => {
    const { google, store } = await setup()
    google.addFile({ name: 'Cursus', parents: ['root'], mimeType: 'application/vnd.google-apps.folder' })
    expect(await store.roots()).toEqual([])
  })

  test('concurrent roots: listing is the union, writes go to the smallest id', async () => {
    const { google, store } = await setup()
    const folder = {
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: { cursusRoot: '1' },
      parents: ['root'],
    }
    const b = google.addFile({ ...folder, name: 'Cursus' })
    const a = google.addFile({ ...folder, name: 'Cursus' })
    const [small, big] = [a, b].sort() as [string, string]
    google.addFile({ name: 'seg/x', parents: [big], bytes: bytes('in big') })
    expect(await store.roots()).toEqual([small, big])
    await store.put('seg/y', bytes('new'))
    const y = [...google.files.values()].find((f) => f.name === 'seg/y')
    expect(y?.parents).toEqual([small])
    expect((await all(store.list('seg/'))).map((e) => e.key)).toEqual(['seg/x', 'seg/y'])
    expect(dec.decode((await store.get({ key: 'seg/x' })) ?? new Uint8Array())).toBe('in big')
  })
})

describe('eventual consistency and duplicates', () => {
  test('delayed visibility: our own writes read back and are updated in place, never duplicated', async () => {
    const { google, clock, store } = await setup({ listDelayMs: 60_000 })
    await store.put('ckpt/d/1', bytes('one'))
    expect(await all(store.list('ckpt/'))).toEqual([]) // not listed yet
    expect(dec.decode((await store.get({ key: 'ckpt/d/1' })) ?? new Uint8Array())).toBe('one')
    await store.put('ckpt/d/1', bytes('two'))
    await store.put('ckpt/d/2', bytes('three'))
    clock.advance(60_000)
    const listed = await all(store.list('ckpt/'))
    expect(listed.map((e) => e.key)).toEqual(['ckpt/d/1', 'ckpt/d/2'])
    expect(listed[0]?.size).toBe(3)
    expect([...google.files.values()].filter((f) => f.name === 'ckpt/d/1')).toHaveLength(1)
    expect(dec.decode((await store.get(listed[0] as Entry)) ?? new Uint8Array())).toBe('two')
  })

  test('without a handle, get reads the oldest duplicate on every device', async () => {
    const { google, clock, store, device } = await setup()
    await store.put('bman/x', bytes('first'))
    const [root] = await store.roots()
    clock.advance(1000)
    google.addFile({ name: 'bman/x', parents: [root as string], bytes: bytes('second') })
    expect(dec.decode((await device().get({ key: 'bman/x' })) ?? new Uint8Array())).toBe('first')
    // An update from another device also lands on the oldest copy.
    await device().put('bman/x', bytes('updated'))
    expect(dec.decode((await store.get({ key: 'bman/x' })) ?? new Uint8Array())).toBe('updated')
  })

  test('byte order, not Drive order: case and collation do not change the listing', async () => {
    const { store } = await setup({ pageSize: 2 })
    for (const k of ['m/b', 'm/B', 'm/a', 'm/_', 'm/Z']) await store.put(k, bytes(k))
    expect((await all(store.list('m/'))).map((e) => e.key)).toEqual(['m/B', 'm/Z', 'm/_', 'm/a', 'm/b'])
  })

  test('list follows every pageToken and asks Drive only for createdTime after the cursor', async () => {
    const { google, clock, store } = await setup({ pageSize: 2 })
    for (let i = 0; i < 5; i++) await store.put(`seg/${i}`, bytes('x'))
    const t = clock.now()
    clock.advance(1)
    await store.put('seg/9', bytes('y'))
    google.calls.length = 0
    expect((await all(store.list('seg/', { createdAfter: t }))).map((e) => e.key)).toEqual(['seg/9'])
    const clause = `createdTime > '${new Date(t).toISOString()}'`
    expect(google.calls.some((c) => new URL(c.url).searchParams.get('q')?.includes(clause))).toBe(true)
    google.calls.length = 0
    expect(await all(store.list('seg/'))).toHaveLength(6)
    expect(google.calls.filter((c) => c.url.includes('pageToken=')).length).toBe(2)
  })
})

describe('idempotent creation', () => {
  test('creates use ids from files.generateIds, fetched in batches', async () => {
    const { google, store } = await setup()
    for (let i = 0; i < 12; i++) await store.put(`k/${i}`, bytes('x'))
    expect(google.calls.filter((c) => c.url.includes('generateIds'))).toHaveLength(2)
    expect([...google.files.keys()].every((id) => id.startsWith('g'))).toBe(true)
  })

  test('a create replayed after a lost response answers 409 and counts as done', async () => {
    let replay = true
    const { google, store } = await setup({
      fetch: (g) => async (url, init) => {
        if (replay && init?.method === 'POST' && url.includes('uploadType=multipart')) {
          replay = false
          await g.fetch(url, init)
        }
        return g.fetch(url, init)
      },
    })
    await store.put('seg/a', bytes('a'))
    expect(google.calls.filter((c) => c.url.includes('uploadType=multipart'))).toHaveLength(2)
    expect([...google.files.values()].filter((f) => f.name === 'seg/a')).toHaveLength(1)
  })

  test('a retry after a lost create response updates the file that landed', async () => {
    let drop = true
    const { google, store } = await setup({
      fetch: (g) => async (url, init) => {
        const res = await g.fetch(url, init)
        if (drop && init?.method === 'POST' && url.includes('uploadType=multipart')) {
          drop = false
          throw new TypeError('connection reset')
        }
        return res
      },
    })
    expect((await kind(store.put('seg/a', bytes('a')))).kind).toBe('network')
    await store.put('seg/a', bytes('a'))
    expect([...google.files.values()].filter((f) => f.name === 'seg/a')).toHaveLength(1)
  })

  test('a file deleted behind our back is created again', async () => {
    const { google, store } = await setup()
    await store.put('seg/a', bytes('a'))
    const id = [...google.files.values()].find((f) => f.name === 'seg/a')?.id as string
    google.files.delete(id)
    expect(await store.get({ key: 'seg/a', handle: id })).toBeNull()
    await store.put('seg/a', bytes('b'))
    google.files.delete([...google.files.values()].find((f) => f.name === 'seg/a')?.id as string)
    expect(await store.get({ key: 'seg/a' })).toBeNull()
    await store.put('seg/a', bytes('c'))
    expect(dec.decode((await store.get({ key: 'seg/a' })) ?? new Uint8Array())).toBe('c')
  })
})

describe('transfers', () => {
  test('multipart up to 5 MB, resumable above, for creates and updates', async () => {
    const { google, store } = await setup()
    const small = new Uint8Array(MULTIPART_MAX).fill(7)
    const big = new Uint8Array(MULTIPART_MAX + 1).fill(9)
    await store.put('chunk/small', small)
    await store.put('chunk/big', big)
    await store.put('chunk/big', small)
    await store.put('chunk/small', big)
    const types = google.calls
      .filter((c) => c.url.includes('uploadType='))
      .map((c) => /uploadType=(\w+)/.exec(c.url)?.[1])
    expect(types).toEqual(['multipart', 'resumable', 'multipart', 'resumable'])
    expect(google.calls.filter((c) => c.method === 'PUT')).toHaveLength(2)
    expect((await store.get({ key: 'chunk/small' }))?.length).toBe(MULTIPART_MAX + 1)
    expect(await store.get({ key: 'chunk/big' })).toEqual(small)
  })

  test('resumable: 409 on a replayed session start, 404 on an update of a vanished file, missing Location', async () => {
    const big = new Uint8Array(MULTIPART_MAX + 1)
    let mode: 'replay' | 'nolocation' | null = null
    const { google, store } = await setup({
      fetch: (g) => async (url, init) => {
        if (url.includes('uploadType=resumable')) {
          if (mode === 'replay' && init?.method === 'POST') {
            mode = null
            const first = await g.fetch(url, init)
            const loc = first.headers.get('location') as string
            await g.fetch(loc, { method: 'PUT', body: new Uint8Array(0) })
          }
          if (mode === 'nolocation') {
            mode = null
            return new Response(null, { status: 200 })
          }
        }
        return g.fetch(url, init)
      },
    })
    mode = 'replay'
    await store.put('chunk/r', big)
    expect([...google.files.values()].filter((f) => f.name === 'chunk/r')).toHaveLength(1)
    google.files.delete([...google.files.values()].find((f) => f.name === 'chunk/r')?.id as string)
    await store.put('chunk/r', big)
    expect(await store.get({ key: 'chunk/r' })).toEqual(big)
    mode = 'nolocation'
    expect((await kind(store.put('chunk/q', big))).kind).toBe('network')
  })

  test('multipart boundary never occurs in the body', () => {
    const body = bytes('--cursus-gdrive-7f3c9e2a and --cursus-gdrive-7f3c9e2a-0')
    const { boundary } = multipart({}, body)
    expect(boundary).toBe('cursus-gdrive-7f3c9e2a-1')
  })
})

describe('errors', () => {
  test('an expired access token is refreshed once, transparently', async () => {
    const { google, store } = await setup()
    await store.put('a', bytes('a'))
    google.expireAccessTokens()
    expect(await store.get({ key: 'a' })).toEqual(bytes('a'))
  })

  test('a 401 that survives the refresh, or a revoked grant, is needs-auth', async () => {
    const { google, store } = await setup()
    google.fail({ status: 401, reason: 'authError', match: '/drive/' })
    google.fail({ status: 401, reason: 'authError', match: '/drive/' })
    expect((await kind(store.get({ key: 'a' }))).kind).toBe('auth')
    google.revokeAll()
    expect((await kind(store.put('a', bytes('a')))).kind).toBe('auth')
  })

  test('403 and 429 reasons map to rate-limited, quota or permission', async () => {
    const { google, store } = await setup()
    await store.put('a', bytes('a'))
    const cases: [number, string, string][] = [
      [403, 'userRateLimitExceeded', 'rate-limited'],
      [403, 'rateLimitExceeded', 'rate-limited'],
      [429, 'tooManyRequests', 'rate-limited'],
      [403, 'storageQuotaExceeded', 'quota'],
      [403, 'insufficientFilePermissions', 'permission'],
      [404, 'notFound', 'permission'],
      [500, 'backendError', 'network'],
      [502, 'no-json', 'network'],
    ]
    for (const [status, reason, expected] of cases) {
      google.fail({ status, reason, retryAfter: status === 429 ? 7 : undefined, match: '/drive/' })
      const e = await kind(all(store.list('')))
      expect([status, reason, e.kind]).toEqual([status, reason, expected])
      if (status === 429) expect(e.retryAfterMs).toBe(7000)
    }
  })

  test('offline is a network error, never a null', async () => {
    const { google, store } = await setup()
    await store.put('a', bytes('a'))
    google.offline = true
    expect((await kind(store.get({ key: 'a' }))).kind).toBe('network')
  })

  test('generateIds returning nothing is a network error', async () => {
    const { store } = await setup({
      fetch: (g) => async (url, init) =>
        url.includes('generateIds') ? new Response(JSON.stringify({}), { status: 200 }) : g.fetch(url, init),
    })
    expect((await kind(store.put('a', bytes('a')))).kind).toBe('network')
  })
})
