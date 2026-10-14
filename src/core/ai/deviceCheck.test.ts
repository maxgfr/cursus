import { describe, expect, test } from 'bun:test'
import type { CatalogProvider } from './catalogTrim'
import { checkKey, classifyFailure, DEVICE_CHECK_DAYS, isFresh, reachOrigin, routeStatus } from './deviceCheck'

const URL_ = 'https://api.example.com/v1'
const DAY = 24 * 60 * 60 * 1000
const env = (online: boolean, reachable: boolean) => ({ online, reach: async () => reachable })
const failedFetch = Object.assign(new Error('Cannot connect to API: Failed to fetch'), {
  cause: new TypeError('Failed to fetch'),
})

describe('classifyFailure', () => {
  test('offline is never CORS', async () => {
    expect(await classifyFailure(failedFetch, URL_, env(false, true))).toBe('offline')
  })

  test('a server that answers no-cors but not the call: CORS', async () => {
    expect(await classifyFailure(failedFetch, URL_, env(true, true))).toBe('cors')
  })

  test('a server that does not answer at all (captive portal, down): network, no verdict', async () => {
    expect(await classifyFailure(failedFetch, URL_, env(true, false))).toBe('network')
  })

  test('an HTTP status means CORS let the answer through; a RetryError is unwrapped', async () => {
    const http = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    expect(await classifyFailure(http, URL_, env(true, true))).toBe('http')
    expect(await classifyFailure({ lastError: failedFetch }, URL_, env(true, false))).toBe('network')
    expect(await classifyFailure(new Error('schema mismatch'), URL_, env(true, true))).toBe('other')
  })

  test('reachOrigin: an opaque answer is reachable, a TypeError is not', async () => {
    const seen: RequestInit[] = []
    const ok = (async (_: unknown, init?: RequestInit) => {
      if (init) seen.push(init)
      return new Response(null)
    }) as unknown as typeof fetch
    const ko = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    expect(await reachOrigin('https://api.example.com', ok)).toBe(true)
    expect(seen[0]?.mode).toBe('no-cors')
    expect(await reachOrigin('https://api.example.com', ko)).toBe(false)
  })
})

const provider = (extra: Partial<CatalogProvider> = {}): CatalogProvider => ({
  id: 'p',
  name: 'P',
  api: URL_,
  baseUrlSource: 'api',
  kind: 'host',
  browser: { verdict: 'callable', evidence: 'preflight', checkedAt: '2026-10-14T00:00:00.000Z' },
  ...extra,
})

describe('routeStatus', () => {
  const now = 1_800_000_000_000
  test('a recent device test wins over the catalog', () => {
    const p = provider()
    expect(routeStatus(p, { [checkKey(p)]: { outcome: 'blocked', at: now - DAY } }, now)).toEqual({
      kind: 'blocked',
      onDevice: true,
    })
    expect(routeStatus(p, { [checkKey(p)]: { outcome: 'works', at: now } }, now)).toEqual({ kind: 'device', at: now })
  })

  test('device verdicts expire', () => {
    const p = provider()
    const old = { outcome: 'blocked' as const, at: now - (DEVICE_CHECK_DAYS + 1) * DAY }
    expect(isFresh(old, now)).toBe(false)
    expect(routeStatus(p, { [checkKey(p)]: old }, now)).toEqual({ kind: 'server' })
  })

  test('a moved provider asks for a new test', () => {
    expect(routeStatus(provider({ previousApi: 'https://old.example/v1' }), {}, now)).toEqual({
      kind: 'moved',
      from: 'https://old.example/v1',
    })
  })
})
