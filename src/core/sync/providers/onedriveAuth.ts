import type { Clock } from '../../contracts/ports'
import { RemoteError } from '../../contracts/remote'
import type { Secrets } from '../../storage/secrets'
import { base64url, createPkce, type Fetch, randomBytes, type TokenSource } from './dropboxAuth'

/**
 * Microsoft identity platform (v2) OAuth 2 with PKCE for a public single-page client: no client secret.
 * `offline_access` gives a refresh token; Microsoft rotates it on every refresh and, for SPA clients, may
 * let it expire after 24 hours. A refused refresh is an `auth` error: the destination then asks to sign in
 * again (its « Reconnect » state) instead of failing silently. Fetch is injected: this module is DOM-free.
 */
export const MS_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0'
export const ONEDRIVE_SCOPE = 'Files.ReadWrite.AppFolder offline_access'

export type { Fetch, TokenSource }

export interface OneDriveTokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms after which the access token must be refreshed. */
  expiresAt: number
}

export interface OneDriveAuthorizeParams {
  clientId: string
  redirectUri: string
  challenge: string
  state: string
  authority?: string
}

export function onedriveAuthorizeUrl(p: OneDriveAuthorizeParams): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: p.redirectUri,
    scope: ONEDRIVE_SCOPE,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
  })
  return `${p.authority ?? MS_AUTHORITY}/authorize?${q}`
}

async function tokenRequest(
  fetch: Fetch,
  authority: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${authority}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    })
  } catch (e) {
    throw new RemoteError('network', `OneDrive token request failed: ${String(e)}`)
  }
  const text = await res.text()
  // invalid_grant (expired or revoked refresh token), invalid_client…: signing in again is the way out.
  if (res.status === 400 || res.status === 401) throw new RemoteError('auth', `OneDrive token refused: ${text}`)
  if (res.status === 429) throw new RemoteError('rate-limited', 'OneDrive token endpoint rate-limited')
  if (!res.ok) throw new RemoteError('network', `OneDrive token endpoint ${res.status}: ${text}`)
  return JSON.parse(text) as Record<string, unknown>
}

function tokensFrom(j: Record<string, unknown>, clock: Clock, previous?: string): OneDriveTokens {
  const refresh = typeof j.refresh_token === 'string' ? j.refresh_token : previous
  if (refresh === undefined) throw new RemoteError('auth', 'OneDrive did not grant offline access')
  return {
    accessToken: String(j.access_token),
    refreshToken: refresh,
    expiresAt: clock.now() + Number(j.expires_in ?? 0) * 1000,
  }
}

export interface OneDriveExchange {
  fetch: Fetch
  clientId: string
  redirectUri: string
  verifier: string
  code: string
  clock: Clock
  authority?: string
}

export async function onedriveExchange(p: OneDriveExchange): Promise<OneDriveTokens> {
  const j = await tokenRequest(p.fetch, p.authority ?? MS_AUTHORITY, {
    client_id: p.clientId,
    grant_type: 'authorization_code',
    scope: ONEDRIVE_SCOPE,
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  })
  return tokensFrom(j, p.clock)
}

export async function onedriveRefresh(
  fetch: Fetch,
  clientId: string,
  tokens: OneDriveTokens,
  clock: Clock,
  authority: string = MS_AUTHORITY,
): Promise<OneDriveTokens> {
  const j = await tokenRequest(fetch, authority, {
    client_id: clientId,
    grant_type: 'refresh_token',
    scope: ONEDRIVE_SCOPE,
    refresh_token: tokens.refreshToken,
  })
  // The refresh token rotates: the new one replaces the old (kept only if none came back).
  return tokensFrom(j, clock, tokens.refreshToken)
}

export const ONEDRIVE_SECRET = 'onedrive-tokens'

export interface OneDriveSessionOptions {
  fetch: Fetch
  clientId: string
  secrets: Secrets
  clock: Clock
  /** Secret name, one per OneDrive destination. */
  name?: string
  marginMs?: number
  authority?: string
}

/** Token source backed by the device-only secrets vault; refreshes are coalesced. */
export function onedriveSession(o: OneDriveSessionOptions): TokenSource {
  const name = o.name ?? ONEDRIVE_SECRET
  const margin = o.marginMs ?? 60_000
  let inflight: Promise<string> | undefined
  const load = async (): Promise<OneDriveTokens> => {
    const t = await o.secrets.get<OneDriveTokens>(name)
    if (!t) throw new RemoteError('auth', 'OneDrive is not connected')
    return t
  }
  const refresh = (): Promise<string> => {
    inflight ??= (async () => {
      try {
        const next = await onedriveRefresh(o.fetch, o.clientId, await load(), o.clock, o.authority)
        await o.secrets.set(name, next)
        return next.accessToken
      } finally {
        inflight = undefined
      }
    })()
    return inflight
  }
  return {
    async token() {
      if (inflight) return inflight
      const t = await load()
      return o.clock.now() + margin >= t.expiresAt ? refresh() : t.accessToken
    },
    refresh,
  }
}

/** Vault entry written before leaving for Microsoft, read back by `finishOneDrive` after the redirect. */
export interface OneDrivePending {
  verifier: string
  redirectUri: string
  name: string
}

export const onedrivePendingName = (state: string): string => `onedrive-pending:${state}`

export interface OneDriveBeginOptions {
  clientId: string
  redirectUri: string
  secrets: Secrets
  name?: string
  random?: (n: number) => Uint8Array
  authority?: string
  /** Seals the log first, so nothing typed is lost while the page is away. */
  seal: () => Promise<unknown>
}

/** Seals, keeps `state` and the PKCE verifier in the device vault, returns the authorize URL (full-page redirect). */
export async function beginOneDrive(o: OneDriveBeginOptions): Promise<string> {
  await o.seal()
  const random = o.random ?? randomBytes
  const pkce = await createPkce(random)
  const state = base64url(random(16))
  const pending: OneDrivePending = {
    verifier: pkce.verifier,
    redirectUri: o.redirectUri,
    name: o.name ?? ONEDRIVE_SECRET,
  }
  await o.secrets.set(onedrivePendingName(state), pending)
  return onedriveAuthorizeUrl({
    clientId: o.clientId,
    redirectUri: o.redirectUri,
    challenge: pkce.challenge,
    state,
    ...(o.authority ? { authority: o.authority } : {}),
  })
}

export interface OneDriveFinishOptions {
  fetch: Fetch
  clientId: string
  secrets: Secrets
  clock: Clock
  authority?: string
  /** The query oauth-callback.html stored under `oauth:<state>`. */
  params: { code?: string; state?: string; error?: string; error_description?: string }
}

/** Back from oauth-callback.html: checks `state`, exchanges the code with the stored verifier, stores the tokens. */
export async function finishOneDrive(o: OneDriveFinishOptions): Promise<string> {
  const state = o.params.state
  if (!state) throw new RemoteError('auth', 'OneDrive authorization returned no state')
  const pending = await o.secrets.get<OneDrivePending>(onedrivePendingName(state))
  if (!pending) throw new RemoteError('auth', 'OneDrive authorization state mismatch')
  await o.secrets.delete(onedrivePendingName(state))
  if (o.params.error)
    throw new RemoteError(
      'auth',
      `OneDrive authorization failed: ${o.params.error} ${o.params.error_description ?? ''}`,
    )
  if (!o.params.code) throw new RemoteError('auth', 'OneDrive authorization returned no code')
  const tokens = await onedriveExchange({
    fetch: o.fetch,
    clientId: o.clientId,
    redirectUri: pending.redirectUri,
    verifier: pending.verifier,
    code: o.params.code,
    clock: o.clock,
    ...(o.authority ? { authority: o.authority } : {}),
  })
  await o.secrets.set(pending.name, tokens)
  return pending.name
}
