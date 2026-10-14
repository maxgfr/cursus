import { sha256 } from '@noble/hashes/sha2.js'
import { RemoteError } from '../../contracts/errors'
import type { Clock, Rng } from '../../contracts/ports'
import type { Secrets } from '../../storage/secrets'

/**
 * Google OAuth for Drive, authorization code + PKCE. The OAuth client (id and, for "Desktop" clients, its
 * secret) is the user's own, entered on each device and kept in the device vault with the refresh token:
 * nothing of it ever reaches the Y.Doc. Never redirects by itself: the UI calls `startAuth` on a user click.
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** Files created by the app only: Cursus never sees the rest of the user's Drive. */
export const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface GDriveClient {
  clientId: string
  /** Per-device secret of the user's OAuth client (Google requires it even with PKCE for non-web clients). */
  clientSecret?: string
}

/** What the device vault holds for one Drive destination. */
export interface GDriveGrant extends GDriveClient {
  refreshToken: string
  accessToken?: string
  /** Epoch ms after which the access token is considered expired. */
  expiresAt?: number
}

export interface PendingAuth {
  url: string
  state: string
  verifier: string
}

/** Refresh this long before Google's announced expiry, so a request never starts with a dying token. */
const EXPIRY_MARGIN_MS = 60_000
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const chars = Math.ceil((Math.min(3, bytes.length - i) * 8) / 6)
    for (let j = 0; j < chars; j++) out += B64URL.charAt((n >> (18 - 6 * j)) & 63)
  }
  return out
}

function randomToken(rng: Rng, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += B64URL.charAt(rng.u32() % 64)
  return out
}

/** RFC 7636 S256 challenge. */
export function pkceChallenge(verifier: string): string {
  return base64url(sha256(new TextEncoder().encode(verifier)))
}

/** Builds the consent URL; the caller keeps `state` and `verifier` in the vault until the callback. */
export function startAuth(o: { client: GDriveClient; redirectUri: string; rng: Rng; loginHint?: string }): PendingAuth {
  const state = randomToken(o.rng, 32)
  const verifier = randomToken(o.rng, 64)
  const q = new URLSearchParams({
    client_id: o.client.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: GDRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  })
  if (o.loginHint) q.set('login_hint', o.loginHint)
  return { url: `${GOOGLE_AUTH_URL}?${q}`, state, verifier }
}

/** Vault entry written before leaving for Google, read back by `finishAuth`. */
export interface PendingGrant {
  verifier: string
  redirectUri: string
  secretName: string
}

export const pendingName = (state: string): string => `gdrive-pending:${state}`

/**
 * What the Connect button runs: seals the log (nothing typed is lost while the page is away), keeps `state` and
 * `verifier` in the vault, and returns the URL the UI navigates to. Never called by sync itself.
 */
export async function beginAuth(o: {
  client: GDriveClient
  redirectUri: string
  rng: Rng
  secrets: Secrets
  secretName: string
  seal: () => Promise<unknown>
}): Promise<string> {
  await o.seal()
  const p = startAuth(o)
  const pending: PendingGrant = { verifier: p.verifier, redirectUri: o.redirectUri, secretName: o.secretName }
  await o.secrets.set(pendingName(p.state), pending)
  return p.url
}

/**
 * Back from oauth-callback.html with its parameters: checks `state`, exchanges the code with the client read
 * from the vault by the caller, stores the grant under the pending secret name. Returns that name.
 */
export async function finishAuth(o: {
  fetch: Fetch
  clock: Clock
  secrets: Secrets
  client: GDriveClient
  params: Record<string, string | undefined>
}): Promise<string> {
  const state = o.params.state
  if (!state) throw new RemoteError('auth', 'OAuth callback without state')
  const pending = await o.secrets.get<PendingGrant>(pendingName(state))
  if (!pending) throw new RemoteError('auth', 'OAuth callback with an unknown state')
  await o.secrets.delete(pendingName(state))
  if (o.params.error) throw new RemoteError('auth', `Google consent refused: ${o.params.error}`)
  if (!o.params.code) throw new RemoteError('auth', 'OAuth callback without code')
  const grant = await completeAuth({
    fetch: o.fetch,
    clock: o.clock,
    client: o.client,
    code: o.params.code,
    verifier: pending.verifier,
    redirectUri: pending.redirectUri,
  })
  await o.secrets.set(pending.secretName, grant)
  return pending.secretName
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

async function tokenRequest(fetch: Fetch, params: Record<string, string>): Promise<TokenResponse> {
  let res: Response
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })
  } catch (e) {
    throw new RemoteError('network', `Google token endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`)
  }
  let body: TokenResponse = {}
  try {
    body = (await res.json()) as TokenResponse
  } catch {
    if (res.ok) throw new RemoteError('network', 'Google token endpoint returned no JSON')
  }
  if (res.ok && body.access_token) return body
  const m = `Google token endpoint: ${res.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim()
  // invalid_grant: refresh token revoked or expired, code reused. Only a new consent fixes it.
  if (body.error === 'invalid_grant' || body.error === 'invalid_client' || body.error === 'unauthorized_client')
    throw new RemoteError('auth', m)
  if (res.status === 429) throw new RemoteError('rate-limited', m, retryAfterMs(res))
  if (res.status === 401 || res.status === 400) throw new RemoteError('auth', m)
  if (res.status === 403) throw new RemoteError('permission', m)
  throw new RemoteError('network', m)
}

export function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after')
  if (h === null) return undefined
  const s = Number(h)
  return Number.isFinite(s) && s >= 0 ? s * 1000 : undefined
}

function client(c: GDriveClient): Record<string, string> {
  return c.clientSecret ? { client_id: c.clientId, client_secret: c.clientSecret } : { client_id: c.clientId }
}

/** Exchanges the callback's code for a grant (to store in the vault). */
export async function completeAuth(o: {
  fetch: Fetch
  clock: Clock
  client: GDriveClient
  code: string
  verifier: string
  redirectUri: string
}): Promise<GDriveGrant> {
  const t = await tokenRequest(o.fetch, {
    ...client(o.client),
    grant_type: 'authorization_code',
    code: o.code,
    code_verifier: o.verifier,
    redirect_uri: o.redirectUri,
  })
  if (!t.refresh_token) throw new RemoteError('auth', 'Google returned no refresh token')
  return {
    ...o.client,
    refreshToken: t.refresh_token,
    accessToken: t.access_token,
    expiresAt: o.clock.now() + (t.expires_in ?? 3600) * 1000,
  }
}

export interface TokenSource {
  /** A valid access token, refreshed (and persisted) when needed. Throws RemoteError('auth') when consent is needed. */
  token(): Promise<string>
  /** Forgets the cached access token after a 401, so the next `token()` refreshes. */
  invalidate(): Promise<void>
}

/** Access tokens for the grant stored under `secretName` in the device vault. */
export function gdriveTokens(o: { fetch: Fetch; clock: Clock; secrets: Secrets; secretName: string }): TokenSource {
  let inflight: Promise<string> | null = null
  const refresh = async (): Promise<string> => {
    const g = await o.secrets.get<GDriveGrant>(o.secretName)
    if (!g?.refreshToken) throw new RemoteError('auth', 'Google Drive is not connected on this device')
    if (g.accessToken && g.expiresAt !== undefined && g.expiresAt - EXPIRY_MARGIN_MS > o.clock.now())
      return g.accessToken
    const t = await tokenRequest(o.fetch, { ...client(g), grant_type: 'refresh_token', refresh_token: g.refreshToken })
    const next: GDriveGrant = {
      ...g,
      // Google may rotate the refresh token; keep the newest.
      refreshToken: t.refresh_token ?? g.refreshToken,
      accessToken: t.access_token,
      expiresAt: o.clock.now() + (t.expires_in ?? 3600) * 1000,
    }
    await o.secrets.set(o.secretName, next)
    return next.accessToken as string
  }
  return {
    token() {
      // One refresh at a time: parallel requests share it.
      inflight ??= refresh().finally(() => {
        inflight = null
      })
      return inflight
    },
    async invalidate() {
      const g = await o.secrets.get<GDriveGrant>(o.secretName)
      if (!g) return
      const rest: GDriveGrant = { ...g }
      delete rest.accessToken
      delete rest.expiresAt
      await o.secrets.set(o.secretName, rest)
    },
  }
}
