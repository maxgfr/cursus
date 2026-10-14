import { type CatalogProvider, isBrowserCallable } from './catalogTrim'

/**
 * What a failed Test tells about a route on this device. Only a proven CORS refusal becomes a
 * "blocked" verdict: being offline, a captive portal or a down server says nothing about the route.
 */
export type FailureKind = 'http' | 'offline' | 'cors' | 'network' | 'other'

/** A device verdict older than this is forgotten: providers change their CORS rules. */
export const DEVICE_CHECK_DAYS = 30
const DAY = 24 * 60 * 60 * 1000

export interface DeviceCheck {
  outcome: 'works' | 'blocked'
  at: number
}

export function isFresh(check: DeviceCheck | undefined, now: number): check is DeviceCheck {
  return check !== undefined && now - check.at < DEVICE_CHECK_DAYS * DAY && check.at <= now
}

export interface FailureEnv {
  online: boolean
  /** Whether the server answers at all, CORS aside (an opaque `no-cors` request). */
  reach(origin: string): Promise<boolean>
}

/** The answer of a no-cors request is opaque but proves the server is there. */
export async function reachOrigin(origin: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    await fetchFn(origin, { mode: 'no-cors', cache: 'no-store', method: 'GET' })
    return true
  } catch (e) {
    if (e instanceof TypeError) return false
    throw e
  }
}

function networkLike(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  if (err instanceof TypeError) return true
  const cause = 'cause' in err ? err.cause : undefined
  if (cause instanceof TypeError) return true
  const message = err instanceof Error ? err.message : ''
  return /failed to fetch|networkerror|load failed|cannot connect/i.test(message)
}

function lastAttempt(err: unknown): unknown {
  // The AI SDK wraps the last attempt's failure in a RetryError.
  if (typeof err === 'object' && err !== null && 'lastError' in err && err.lastError !== undefined) {
    return lastAttempt(err.lastError)
  }
  return err
}

export async function classifyFailure(err: unknown, url: string, env: FailureEnv): Promise<FailureKind> {
  const e = lastAttempt(err)
  if (typeof e === 'object' && e !== null && 'statusCode' in e && typeof e.statusCode === 'number') return 'http'
  if (!networkLike(e)) return 'other'
  if (!env.online) return 'offline'
  // The fetch failed but the server answers a no-cors request: the browser refused the answer.
  return (await env.reach(new URL(url).origin)) ? 'cors' : 'network'
}

export type DeviceChecks = Record<string, DeviceCheck>

/** Device checks are per provider and per URL actually called. */
export const checkKey = (provider: { id: string; api: string | null }) => `${provider.id} ${provider.api ?? ''}`

/** What is known about calling a route from this browser, this device's recent test first. */
export type RouteStatus =
  | { kind: 'device'; at: number }
  | { kind: 'server' }
  | { kind: 'blocked'; onDevice: boolean }
  /** models.dev moved the provider to another address since it was checked. */
  | { kind: 'moved'; from: string }
  | { kind: 'unknown' }

export function routeStatus(provider: CatalogProvider, checks: DeviceChecks, now: number): RouteStatus {
  const check = checks[checkKey(provider)]
  if (isFresh(check, now)) {
    return check.outcome === 'works' ? { kind: 'device', at: check.at } : { kind: 'blocked', onDevice: true }
  }
  if (provider.previousApi) return { kind: 'moved', from: provider.previousApi }
  if (isBrowserCallable(provider)) return { kind: 'server' }
  if (provider.browser.verdict === 'blocked') return { kind: 'blocked', onDevice: false }
  return { kind: 'unknown' }
}
