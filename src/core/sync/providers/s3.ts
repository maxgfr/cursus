import { AwsClient } from 'aws4fetch'
import { RemoteError, type RemoteErrorKind } from '../../contracts/errors'
import type { Entry, Key, RemoteStore } from '../../contracts/remote'
import { destinationId, normalizePrefix } from '../identity'
import { parseError, parseListPage, type S3ErrorBody } from './s3xml'

/** The part of fetch the provider uses: a signed Request, or a URL for the CORS probe. */
export type FetchFn = (input: Request | string, init?: RequestInit) => Promise<Response>

export interface S3Options {
  /** Base URL without the bucket, e.g. `https://<account>.r2.cloudflarestorage.com`; path-style addressing. */
  endpoint: string
  region: string
  bucket: string
  prefix?: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Default page size when the caller does not pass one (S3 caps it at 1000). */
  pageSize?: number
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: FetchFn
  /** Local time, for signing; defaults to Date.now. */
  now?: () => number
}

export type S3Problem = 'cors' | 'network' | 'keys' | 'region' | 'bucket' | 'permission' | RemoteErrorKind

export type S3Diagnosis = { ok: true } | { ok: false; problem: S3Problem; detail: string; region?: string }

export interface S3Remote extends RemoteStore {
  readonly prefix: string
  /** Checks endpoint, CORS, keys, region and bucket with one listing, and says which one is wrong. */
  diagnose(): Promise<S3Diagnosis>
}

/** A RemoteError that keeps the S3 error code, for the connection diagnosis. */
export class S3Error extends RemoteError {
  constructor(
    kind: RemoteErrorKind,
    m: string,
    readonly status: number,
    readonly body: S3ErrorBody,
    retryAfterMs?: number,
  ) {
    super(kind, m, retryAfterMs)
  }
}

const AUTH_CODES = new Set(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken'])
const REGION_CODES = new Set([
  'AuthorizationHeaderMalformed',
  'PermanentRedirect',
  'IllegalLocationConstraintException',
])
const QUOTA_CODES = new Set(['QuotaExceeded', 'XMinioStorageFull', 'StorageFull', 'EntityTooLarge'])

/** `Retry-After` is either seconds or an HTTP date. */
function retryAfter(h: string | null, now: number): number | undefined {
  if (!h) return undefined
  const s = Number(h)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const t = Date.parse(h)
  return Number.isNaN(t) ? undefined : Math.max(0, t - now)
}

/** Maps an HTTP failure to a RemoteError kind; the S3 code wins over the status. */
export function classify(status: number, body: S3ErrorBody): RemoteErrorKind {
  const code = body.code ?? ''
  if (code === 'RequestTimeTooSkewed') return 'clock-skew'
  if (status === 429 || code === 'SlowDown' || code === 'TooManyRequests') return 'rate-limited'
  if (QUOTA_CODES.has(code) || status === 507) return 'quota'
  if (AUTH_CODES.has(code) || REGION_CODES.has(code) || status === 401) return 'auth'
  if (status === 301 || status === 403 || (status >= 400 && status < 500)) return 'permission'
  return 'network'
}

/** `20261014T120000Z`, the form aws4fetch expects in `aws.datetime`. */
const amzDate = (ms: number): string => new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, '')

const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/')

export function s3Remote(o: S3Options): S3Remote {
  const prefix = normalizePrefix(o.prefix) === '' ? '' : `${normalizePrefix(o.prefix)}/`
  const endpoint = o.endpoint.replace(/\/+$/, '')
  const base = `${endpoint}/${encodeURIComponent(o.bucket)}`
  const doFetch: FetchFn = o.fetch ?? ((input, init) => fetch(input, init))
  const now = o.now ?? Date.now
  const aws = new AwsClient({
    accessKeyId: o.accessKeyId,
    secretAccessKey: o.secretAccessKey,
    ...(o.sessionToken ? { sessionToken: o.sessionToken } : {}),
    service: 's3',
    region: o.region,
    retries: 0,
  })
  /** Server time minus local time, learnt from a RequestTimeTooSkewed answer. */
  let skewMs = 0

  async function send(method: string, url: string, body?: Uint8Array): Promise<Response> {
    const req = await aws.sign(url, {
      method,
      ...(body ? { body: body.slice(), headers: { 'content-type': 'application/octet-stream' } } : {}),
      aws: { datetime: amzDate(now() + skewMs) },
    })
    try {
      return await doFetch(req)
    } catch (e) {
      throw new RemoteError('network', `${method} ${url}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * One signed request. A RequestTimeTooSkewed answer is retried once, signed with the server's time
   * (Date header, or ServerTime in the body); a second refusal is a clock-skew error.
   * Returns the 404 NoSuchKey response as is: only the caller knows whether it means "absent".
   */
  async function request(method: string, url: string, body?: Uint8Array): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await send(method, url, body)
      if (res.ok) return res
      const err = parseError(await res.text())
      if (res.status === 404 && err.code === 'NoSuchKey') return res
      const kind = classify(res.status, err)
      if (kind === 'clock-skew' && attempt === 0) {
        const server = Date.parse(res.headers.get('date') ?? '') || Date.parse(err.serverTime ?? '')
        if (!Number.isNaN(server)) {
          skewMs = server - now()
          continue
        }
      }
      const what = err.code ? `${err.code}${err.message ? `: ${err.message}` : ''}` : `HTTP ${res.status}`
      throw new S3Error(
        kind,
        `${method} ${url}: ${what}`,
        res.status,
        err,
        retryAfter(res.headers.get('retry-after'), now()),
      )
    }
  }

  function listUrl(full: string, maxKeys: number, startAfter?: string, token?: string): string {
    const q = new URLSearchParams({ 'list-type': '2', prefix: full, 'max-keys': String(maxKeys) })
    if (token !== undefined) q.set('continuation-token', token)
    else if (startAfter !== undefined) q.set('start-after', startAfter)
    return `${base}?${q.toString()}`
  }

  const store: S3Remote = {
    id: destinationId({ type: 's3', endpoint, bucket: o.bucket, prefix: o.prefix }),
    prefix,
    // createdAfter is ignored: LastModified is server time, and "at least" everything is a valid answer.
    list(listPrefix, lo) {
      const pageSize = Math.min(1000, Math.max(1, lo?.pageSize ?? o.pageSize ?? 1000))
      const full = prefix + listPrefix
      const startAfter = lo?.startAfter === undefined ? undefined : prefix + lo.startAfter
      return {
        async *[Symbol.asyncIterator]() {
          let token: string | undefined
          for (;;) {
            const res = await request('GET', listUrl(full, pageSize, startAfter, token))
            const page = parseListPage(await res.text())
            for (const x of page.objects) yield { key: x.key.slice(prefix.length), size: x.size } as Entry
            if (!page.truncated) return
            if (!page.nextToken) throw new RemoteError('network', 'S3 listing truncated without a continuation token')
            token = page.nextToken
          }
        },
      }
    },
    async get(e) {
      const res = await request('GET', `${base}/${encodeKey(prefix + e.key)}`)
      if (res.status === 404) return null
      return new Uint8Array(await res.arrayBuffer())
    },
    async put(key: Key, body) {
      const res = await request('PUT', `${base}/${encodeKey(prefix + key)}`, body)
      await res.arrayBuffer()
    },
    async diagnose() {
      try {
        const res = await request('GET', listUrl(prefix, 1))
        await res.text()
        return { ok: true }
      } catch (e) {
        return diagnosis(e, endpoint, doFetch)
      }
    },
  }
  return store
}

async function diagnosis(e: unknown, endpoint: string, doFetch: FetchFn): Promise<S3Diagnosis> {
  if (!(e instanceof RemoteError)) throw e
  if (!(e instanceof S3Error)) {
    // The signed request never got an answer. If an opaque request reaches the server, the browser hid the
    // answer: CORS is missing or wrong on the bucket. Otherwise the endpoint is unreachable.
    try {
      await doFetch(endpoint, { method: 'GET', mode: 'no-cors' })
      return { ok: false, problem: 'cors', detail: e.message }
    } catch {
      return { ok: false, problem: 'network', detail: e.message }
    }
  }
  const code = e.body.code ?? ''
  const region = e.body.region
  const withRegion = region ? { region } : {}
  if (REGION_CODES.has(code) || e.status === 301)
    return { ok: false, problem: 'region', detail: e.message, ...withRegion }
  if (AUTH_CODES.has(code)) return { ok: false, problem: 'keys', detail: e.message }
  if (code === 'NoSuchBucket') return { ok: false, problem: 'bucket', detail: e.message }
  return { ok: false, problem: e.kind, detail: e.message }
}

/**
 * CORS rules the bucket needs for Cursus running at `origin`, per provider. JSON is what the AWS and R2
 * consoles take; XML is the PutBucketCors body (`mc cors set` for MinIO, the S3 API for B2).
 * `Date` is exposed so a skewed clock can be corrected from the browser.
 */
export function corsConfigFor(origin: string): { aws: string; r2: string; minio: string; b2: string } {
  const methods = ['GET', 'PUT', 'HEAD']
  const expose = ['ETag', 'Date']
  const rule = {
    AllowedOrigins: [origin],
    AllowedMethods: methods,
    AllowedHeaders: ['*'],
    ExposeHeaders: expose,
    MaxAgeSeconds: 3600,
  }
  const json = JSON.stringify([rule], null, 2)
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const xml = [
    '<CORSConfiguration>',
    '  <CORSRule>',
    `    <AllowedOrigin>${esc(origin)}</AllowedOrigin>`,
    ...methods.map((m) => `    <AllowedMethod>${m}</AllowedMethod>`),
    '    <AllowedHeader>*</AllowedHeader>',
    ...expose.map((h) => `    <ExposeHeader>${h}</ExposeHeader>`),
    '    <MaxAgeSeconds>3600</MaxAgeSeconds>',
    '  </CORSRule>',
    '</CORSConfiguration>',
  ].join('\n')
  return { aws: json, r2: json, minio: xml, b2: xml }
}
