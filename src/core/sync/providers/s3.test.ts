import { describe, expect, test } from 'bun:test'
import { remoteContract } from '../../../../tests/contract/remote.contract'
import { RemoteError } from '../../contracts/errors'
import type { Entry } from '../../contracts/remote'
import { classify, corsConfigFor, S3Error, s3Remote } from './s3'
import { decodeEntities, parseError, parseListPage, tagText } from './s3xml'

const enc = new TextEncoder()
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const errorXml = (code: string, extra = ''): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>m &amp; m</Message>${extra}</Error>`

/** Parses aws4fetch's `20261014T120000Z`. */
const parseAmz = (d: string): number =>
  Date.parse(
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`,
  )

/** A small path-style S3 behind an injected fetch: ListObjectsV2, GET, PUT, signature presence, skew. */
class FakeS3 {
  readonly objects = new Map<string, Uint8Array>()
  readonly requests: Request[] = []
  offline = false
  serverNow = Date.parse('2026-10-14T12:00:00Z')
  /** Canned answers served (and consumed) before the normal behaviour. */
  readonly canned: (() => Response)[] = []

  constructor(readonly bucket = 'b') {}

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init)
    this.requests.push(req)
    if (this.offline) throw new TypeError('Failed to fetch')
    const next = this.canned.shift()
    if (next) return next()
    const date = { date: new Date(this.serverNow).toUTCString() }
    if (!req.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256')) return new Response('', { status: 403 })
    if (Math.abs(parseAmz(req.headers.get('x-amz-date') ?? '') - this.serverNow) > 15 * 60_000)
      return new Response(errorXml('RequestTimeTooSkewed'), { status: 403, headers: date })
    const url = new URL(req.url)
    const [, bucket, ...rest] = url.pathname.split('/')
    if (bucket !== this.bucket) return new Response(errorXml('NoSuchBucket'), { status: 404 })
    const key = rest.map(decodeURIComponent).join('/')
    if (req.method === 'PUT') {
      this.objects.set(key, new Uint8Array(await req.arrayBuffer()))
      return new Response('', { status: 200, headers: date })
    }
    if (key === '' && url.searchParams.get('list-type') === '2') return this.list(url.searchParams)
    const body = this.objects.get(key)
    if (!body) return new Response(errorXml('NoSuchKey'), { status: 404 })
    return new Response(body.slice(), { status: 200 })
  }

  private list(q: URLSearchParams): Response {
    const prefix = q.get('prefix') ?? ''
    const max = Number(q.get('max-keys') ?? 1000)
    const after = q.get('continuation-token') ?? q.get('start-after') ?? ''
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort()
    const page = keys.slice(0, max)
    const truncated = keys.length > max
    const contents = page
      .map((k) => `<Contents><Key>${esc(k)}</Key><Size>${this.objects.get(k)?.length}</Size></Contents>`)
      .join('')
    const token = truncated ? `<NextContinuationToken>${esc(page[page.length - 1] ?? '')}</NextContinuationToken>` : ''
    return new Response(
      `<ListBucketResult><Name>b</Name><IsTruncated>${truncated}</IsTruncated>${contents}${token}</ListBucketResult>`,
    )
  }
}

const make = (fake: FakeS3, extra: Partial<Parameters<typeof s3Remote>[0]> = {}) =>
  s3Remote({
    endpoint: 'https://s3.example.com/',
    region: 'auto',
    bucket: 'b',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    fetch: fake.fetch,
    now: () => fake.serverNow,
    ...extra,
  })

async function all(it: AsyncIterable<Entry>): Promise<Entry[]> {
  const out: Entry[] = []
  for await (const e of it) out.push(e)
  return out
}

remoteContract('s3 (fake, with prefix)', () => {
  const fake = new FakeS3()
  return {
    store: make(fake, { prefix: '/root/' }),
    goOffline: () => {
      fake.offline = true
    },
  }
})

remoteContract('s3 (fake, no prefix, page size 2, session token)', () => {
  const fake = new FakeS3()
  return { store: make(fake, { pageSize: 2, sessionToken: 'tok' }) }
})

describe('s3xml', () => {
  test('decodes named and numeric entities, leaves unknown ones', () => {
    expect(decodeEntities('a&amp;b&lt;&gt;&quot;&apos;&#233;&#xFC;&nbsp;')).toBe('a&b<>"\'éü&nbsp;')
  })

  test('parses a ListObjectsV2 page', () => {
    const xml = `<ListBucketResult xmlns="x"><IsTruncated>true</IsTruncated>
      <Contents><Key>a&amp;b</Key><Size>3</Size></Contents>
      <Contents><Key>c</Key></Contents><Contents><Size>1</Size></Contents>
      <NextContinuationToken>t&lt;1</NextContinuationToken></ListBucketResult>`
    expect(parseListPage(xml)).toEqual({
      objects: [
        { key: 'a&b', size: 3 },
        { key: 'c', size: 0 },
      ],
      truncated: true,
      nextToken: 't<1',
    })
    expect(parseListPage('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')).toEqual({
      objects: [],
      truncated: false,
    })
  })

  test('parses <Error> bodies and ignores anything else', () => {
    expect(
      parseError(errorXml('AuthorizationHeaderMalformed', '<Region>eu-west-1</Region><ServerTime>2026</ServerTime>')),
    ).toEqual({ code: 'AuthorizationHeaderMalformed', message: 'm & m', region: 'eu-west-1', serverTime: '2026' })
    expect(parseError('<html>nope</html>')).toEqual({})
    expect(parseError('<Error></Error>')).toEqual({})
    expect(tagText('<Key a="1">x</Key>', 'Key')).toBe('x')
    expect(tagText('<Other/>', 'Key')).toBeUndefined()
  })
})

describe('s3Remote', () => {
  test('lists with start-after on the first page and continuation-token after', async () => {
    const fake = new FakeS3()
    const store = make(fake, { prefix: 'p' })
    for (const k of ['seg/a', 'seg/b', 'seg/c', 'seg/d']) await store.put(k, enc.encode(k))
    fake.requests.length = 0
    const got = await all(store.list('seg/', { startAfter: 'seg/a', pageSize: 2 }))
    expect(got).toEqual([
      { key: 'seg/b', size: 5 },
      { key: 'seg/c', size: 5 },
      { key: 'seg/d', size: 5 },
    ])
    const qs = fake.requests.map((r) => new URL(r.url).searchParams)
    expect(qs.map((q) => q.get('start-after'))).toEqual(['p/seg/a', null])
    expect(qs.map((q) => q.get('continuation-token'))).toEqual([null, 'p/seg/c'])
    expect(qs.every((q) => q.get('prefix') === 'p/seg/' && q.get('max-keys') === '2')).toBe(true)
  })

  test('page size is clamped to what S3 accepts', async () => {
    const fake = new FakeS3()
    await all(make(fake).list('', { pageSize: 5000 }))
    await all(make(fake).list('', { pageSize: 0 }))
    expect(fake.requests.map((r) => new URL(r.url).searchParams.get('max-keys'))).toEqual(['1000', '1'])
  })

  test('a truncated page without a token is an error, not an end', async () => {
    const fake = new FakeS3()
    fake.canned.push(() => new Response('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>'))
    await expect(all(make(fake).list(''))).rejects.toMatchObject({ kind: 'network' })
  })

  test('path-style URLs with each key segment encoded; id depends on the destination', async () => {
    const fake = new FakeS3()
    await make(fake).put('mirror/a b/é+%.md', enc.encode('x'))
    expect(fake.requests[0]?.url).toBe('https://s3.example.com/b/mirror/a%20b/%C3%A9%2B%25.md')
    expect(fake.requests[0]?.headers.get('content-type')).toBe('application/octet-stream')
    expect(make(fake).id).toMatch(/^s3-[0-9a-f]{16}$/)
    expect(make(fake).id).toBe(make(fake, { endpoint: 'https://S3.example.com' }).id)
    expect(make(fake).id).not.toBe(make(fake, { prefix: 'x' }).id)
  })

  test('get is null only on NoSuchKey; another 404 is an error', async () => {
    const fake = new FakeS3()
    expect(await make(fake).get({ key: 'nope' })).toBeNull()
    await expect(make(fake, { bucket: 'other' }).get({ key: 'nope' })).rejects.toMatchObject({ kind: 'permission' })
    fake.canned.push(() => new Response('', { status: 404 }))
    await expect(make(fake).get({ key: 'nope' })).rejects.toBeInstanceOf(RemoteError)
  })

  test('maps HTTP failures to RemoteError kinds with Retry-After', async () => {
    const fake = new FakeS3()
    const store = make(fake)
    fake.canned.push(() => new Response(errorXml('SlowDown'), { status: 503, headers: { 'retry-after': '2' } }))
    await expect(store.get({ key: 'k' })).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 2000 })
    const at = new Date(fake.serverNow + 5000).toUTCString()
    fake.canned.push(() => new Response('', { status: 429, headers: { 'retry-after': at } }))
    await expect(store.get({ key: 'k' })).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 5000 })
    fake.canned.push(() => new Response('', { status: 429, headers: { 'retry-after': 'soon' } }))
    await expect(store.get({ key: 'k' })).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: undefined })
    fake.canned.push(() => new Response(errorXml('QuotaExceeded'), { status: 403 }))
    await expect(store.put('k', enc.encode('x'))).rejects.toMatchObject({ kind: 'quota' })
    fake.canned.push(() => new Response(errorXml('InvalidAccessKeyId'), { status: 403 }))
    await expect(store.put('k', enc.encode('x'))).rejects.toMatchObject({ kind: 'auth' })
    fake.canned.push(() => new Response('', { status: 500 }))
    await expect(all(store.list(''))).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('HTTP 500'),
    })
    fake.offline = true
    await expect(store.get({ key: 'k' })).rejects.toMatchObject({ kind: 'network' })
  })

  test('a non-Error thrown by fetch is still a network error', async () => {
    const store = make(new FakeS3(), {
      fetch: async () => {
        throw 'boom'
      },
    })
    await expect(store.get({ key: 'k' })).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('boom'),
    })
  })

  test('classify', () => {
    expect(classify(403, { code: 'RequestTimeTooSkewed' })).toBe('clock-skew')
    expect(classify(429, {})).toBe('rate-limited')
    expect(classify(503, { code: 'TooManyRequests' })).toBe('rate-limited')
    expect(classify(507, {})).toBe('quota')
    expect(classify(400, { code: 'EntityTooLarge' })).toBe('quota')
    expect(classify(401, {})).toBe('auth')
    expect(classify(400, { code: 'AuthorizationHeaderMalformed' })).toBe('auth')
    expect(classify(301, {})).toBe('permission')
    expect(classify(403, { code: 'AccessDenied' })).toBe('permission')
    expect(classify(409, {})).toBe('permission')
    expect(classify(502, {})).toBe('network')
  })

  test('clock skew: re-signs once with the server Date, and keeps the offset', async () => {
    const fake = new FakeS3()
    const local = fake.serverNow - 3_600_000
    const store = make(fake, { now: () => local })
    await store.put('k', enc.encode('x'))
    expect(fake.requests.length).toBe(2)
    expect(parseAmz(fake.requests[1]?.headers.get('x-amz-date') ?? '')).toBe(fake.serverNow)
    expect(await store.get({ key: 'k' })).toEqual(enc.encode('x'))
    expect(fake.requests.length).toBe(3)
  })

  test('clock skew: ServerTime from the body when there is no Date header', async () => {
    const fake = new FakeS3()
    const iso = new Date(fake.serverNow).toISOString()
    fake.canned.push(
      () => new Response(errorXml('RequestTimeTooSkewed', `<ServerTime>${iso}</ServerTime>`), { status: 403 }),
    )
    await make(fake, { now: () => 0 }).put('k', enc.encode('x'))
    expect(parseAmz(fake.requests[1]?.headers.get('x-amz-date') ?? '')).toBe(fake.serverNow)
  })

  test('clock skew without a usable server time, or refused twice, is a clock-skew error', async () => {
    const fake = new FakeS3()
    fake.canned.push(() => new Response(errorXml('RequestTimeTooSkewed'), { status: 403 }))
    await expect(make(fake).get({ key: 'k' })).rejects.toMatchObject({ kind: 'clock-skew' })
    const skewed = () =>
      new Response(errorXml('RequestTimeTooSkewed'), { status: 403, headers: { date: new Date(0).toUTCString() } })
    fake.canned.push(skewed, skewed)
    await expect(make(fake).get({ key: 'k' })).rejects.toMatchObject({ kind: 'clock-skew' })
  })
})

describe('diagnose', () => {
  test('ok when the listing works', async () => {
    expect(await make(new FakeS3()).diagnose()).toEqual({ ok: true })
  })

  test('cors when the server is reachable without the signed request, network otherwise', async () => {
    const probes: RequestInit[] = []
    const cors = make(new FakeS3(), {
      fetch: async (input, init) => {
        if (input instanceof Request) throw new TypeError('Failed to fetch')
        probes.push(init ?? {})
        return new Response(null, { status: 200 })
      },
    })
    expect(await cors.diagnose()).toMatchObject({ ok: false, problem: 'cors' })
    expect(probes[0]?.mode).toBe('no-cors')
    const fake = new FakeS3()
    fake.offline = true
    expect(await make(fake).diagnose()).toMatchObject({ ok: false, problem: 'network' })
  })

  test('keys, region, bucket and other kinds', async () => {
    const cases: [Response, object][] = [
      [new Response(errorXml('SignatureDoesNotMatch'), { status: 403 }), { problem: 'keys' }],
      [
        new Response(errorXml('AuthorizationHeaderMalformed', '<Region>eu-west-1</Region>'), { status: 400 }),
        { problem: 'region', region: 'eu-west-1' },
      ],
      [new Response('', { status: 301 }), { problem: 'region' }],
      [new Response(errorXml('NoSuchBucket'), { status: 404 }), { problem: 'bucket' }],
      [new Response(errorXml('AccessDenied'), { status: 403 }), { problem: 'permission' }],
    ]
    for (const [res, want] of cases) {
      const fake = new FakeS3()
      fake.canned.push(() => res)
      const d = await make(fake).diagnose()
      expect(d).toMatchObject({ ok: false, ...want })
      if (!d.ok) expect(d.detail.length).toBeGreaterThan(0)
    }
  })

  test('S3Error carries the status and parsed body', () => {
    const e = new S3Error('auth', 'x', 403, { code: 'InvalidAccessKeyId' })
    expect(e).toBeInstanceOf(RemoteError)
    expect(e.status).toBe(403)
    expect(e.body.code).toBe('InvalidAccessKeyId')
  })
})

describe('corsConfigFor', () => {
  test('JSON for AWS and R2, XML for MinIO and B2, with the origin and Date exposed', () => {
    const c = corsConfigFor('https://me.github.io')
    const rules = JSON.parse(c.aws)
    expect(rules).toEqual([
      {
        AllowedOrigins: ['https://me.github.io'],
        AllowedMethods: ['GET', 'PUT', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag', 'Date'],
        MaxAgeSeconds: 3600,
      },
    ])
    expect(c.r2).toBe(c.aws)
    expect(c.b2).toBe(c.minio)
    expect(c.minio).toContain('<AllowedOrigin>https://me.github.io</AllowedOrigin>')
    expect(c.minio).toContain('<AllowedMethod>PUT</AllowedMethod>')
    expect(c.minio).toContain('<ExposeHeader>Date</ExposeHeader>')
    expect(corsConfigFor('http://a<&>').minio).toContain('http://a&lt;&amp;&gt;')
  })
})
