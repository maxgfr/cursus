import type { Clock } from '../../contracts/ports'
import { RemoteError } from '../../contracts/remote'
import type { Secrets } from '../../storage/secrets'

/**
 * Dropbox OAuth 2 with PKCE and no client secret (the app is a static PWA). Offline access
 * gives a refresh token; access tokens are refreshed with the client id alone. Fetch is
 * injected so this module stays DOM-free; the redirect page hands the code back through
 * an injected function.
 */
export const DROPBOX_AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize'
export const DROPBOX_TOKEN = 'https://api.dropboxapi.com/oauth2/token'

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export interface DropboxTokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms after which the access token must be refreshed. */
  expiresAt: number
  accountId?: string
}

export interface Pkce {
  verifier: string
  challenge: string
}

export function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Random verifier (64 url-safe chars) and its S256 challenge. */
export async function createPkce(random: (n: number) => Uint8Array = randomBytes): Promise<Pkce> {
  const verifier = base64url(random(48))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

export interface AuthorizeParams {
  clientId: string
  redirectUri: string
  challenge: string
  state: string
}

export function authorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: 'code',
    redirect_uri: p.redirectUri,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    state: p.state,
  })
  return `${DROPBOX_AUTHORIZE}?${q}`
}

async function tokenRequest(fetch: Fetch, form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(DROPBOX_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    })
  } catch (e) {
    throw new RemoteError('network', `Dropbox token request failed: ${String(e)}`)
  }
  const text = await res.text()
  if (res.status === 400 || res.status === 401) throw new RemoteError('auth', `Dropbox token refused: ${text}`)
  if (res.status === 429) throw new RemoteError('rate-limited', 'Dropbox token endpoint rate-limited')
  if (!res.ok) throw new RemoteError('network', `Dropbox token endpoint ${res.status}: ${text}`)
  return JSON.parse(text) as Record<string, unknown>
}

export interface ExchangeParams {
  fetch: Fetch
  clientId: string
  redirectUri: string
  verifier: string
  code: string
  clock: Clock
}

export async function exchangeCode(p: ExchangeParams): Promise<DropboxTokens> {
  const j = await tokenRequest(p.fetch, {
    grant_type: 'authorization_code',
    code: p.code,
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  })
  if (typeof j.refresh_token !== 'string') throw new RemoteError('auth', 'Dropbox did not grant offline access')
  return {
    accessToken: String(j.access_token),
    refreshToken: j.refresh_token,
    expiresAt: p.clock.now() + Number(j.expires_in ?? 0) * 1000,
    accountId: typeof j.account_id === 'string' ? j.account_id : undefined,
  }
}

export async function refreshTokens(
  fetch: Fetch,
  clientId: string,
  tokens: DropboxTokens,
  clock: Clock,
): Promise<DropboxTokens> {
  const j = await tokenRequest(fetch, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: clientId,
  })
  return {
    ...tokens,
    accessToken: String(j.access_token),
    expiresAt: clock.now() + Number(j.expires_in ?? 0) * 1000,
  }
}

/** What the Dropbox provider needs: a current token, and a forced refresh after a 401. */
export interface TokenSource {
  token(): Promise<string>
  refresh(): Promise<string>
}

export const DROPBOX_SECRET = 'dropbox-tokens'

export interface SessionOptions {
  fetch: Fetch
  clientId: string
  secrets: Secrets
  clock: Clock
  /** Secret name, one per Dropbox destination. */
  name?: string
  /** Refresh this long before expiry. */
  marginMs?: number
}

/** Token source backed by the device-only secrets vault; refreshes are coalesced. */
export function dropboxSession(o: SessionOptions): TokenSource {
  const name = o.name ?? DROPBOX_SECRET
  const margin = o.marginMs ?? 60_000
  let inflight: Promise<string> | undefined
  const load = async (): Promise<DropboxTokens> => {
    const t = await o.secrets.get<DropboxTokens>(name)
    if (!t) throw new RemoteError('auth', 'Dropbox is not connected')
    return t
  }
  const refresh = (): Promise<string> => {
    inflight ??= (async () => {
      try {
        const next = await refreshTokens(o.fetch, o.clientId, await load(), o.clock)
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

/** Vault entry written before leaving for Dropbox, read back by `finishDropbox` after the redirect. */
export interface DropboxPending {
  verifier: string
  redirectUri: string
  name: string
}

export const dropboxPendingName = (state: string): string => `dropbox-pending:${state}`

export interface BeginOptions {
  clientId: string
  redirectUri: string
  secrets: Secrets
  /** Secret name the tokens will be stored under, one per Dropbox destination. */
  name?: string
  random?: (n: number) => Uint8Array
  /** Seals the log first, so nothing typed is lost while the page is away. */
  seal: () => Promise<unknown>
}

/**
 * What the Connect button runs: seals, keeps `state` and the PKCE verifier in the device vault, and returns
 * the authorize URL the UI navigates to. Survives the full-page redirect (installed PWAs cannot use popups).
 */
export async function beginDropbox(o: BeginOptions): Promise<string> {
  await o.seal()
  const random = o.random ?? randomBytes
  const pkce = await createPkce(random)
  const state = base64url(random(16))
  const pending: DropboxPending = {
    verifier: pkce.verifier,
    redirectUri: o.redirectUri,
    name: o.name ?? DROPBOX_SECRET,
  }
  await o.secrets.set(dropboxPendingName(state), pending)
  return authorizeUrl({ clientId: o.clientId, redirectUri: o.redirectUri, challenge: pkce.challenge, state })
}

export interface FinishOptions {
  fetch: Fetch
  clientId: string
  secrets: Secrets
  clock: Clock
  /** The query oauth-callback.html stored under `oauth:<state>` (its `params`). */
  params: { code?: string; state?: string; error?: string }
}

/**
 * Back from oauth-callback.html: checks `state` against the pending vault entry, exchanges the code with the
 * stored verifier (no client secret), stores the tokens, drops the pending entry. Returns the secret name.
 */
export async function finishDropbox(o: FinishOptions): Promise<string> {
  const state = o.params.state
  if (!state) throw new RemoteError('auth', 'Dropbox authorization returned no state')
  const pending = await o.secrets.get<DropboxPending>(dropboxPendingName(state))
  if (!pending) throw new RemoteError('auth', 'Dropbox authorization state mismatch')
  await o.secrets.delete(dropboxPendingName(state))
  if (o.params.error) throw new RemoteError('auth', `Dropbox authorization failed: ${o.params.error}`)
  if (!o.params.code) throw new RemoteError('auth', 'Dropbox authorization returned no code')
  const tokens = await exchangeCode({
    fetch: o.fetch,
    clientId: o.clientId,
    redirectUri: pending.redirectUri,
    verifier: pending.verifier,
    code: o.params.code,
    clock: o.clock,
  })
  await o.secrets.set(pending.name, tokens)
  return pending.name
}

export interface ConnectOptions {
  fetch: Fetch
  clientId: string
  redirectUri: string
  secrets: Secrets
  clock: Clock
  name?: string
  random?: (n: number) => Uint8Array
  /** Defaults to nothing: a popup does not leave the page. */
  seal?: () => Promise<unknown>
  /**
   * Opens the authorize URL without leaving the page (popup) and resolves with the query the redirect page
   * received. For a full-page redirect use `beginDropbox` then `finishDropbox`.
   */
  authorize(url: string): Promise<{ code?: string; state?: string; error?: string }>
}

/** In-page flow built on the persisted one: begin, authorize, finish, return the stored tokens. */
export async function connectDropbox(o: ConnectOptions): Promise<DropboxTokens> {
  const url = await beginDropbox({ ...o, seal: o.seal ?? (async () => undefined) })
  const name = await finishDropbox({ ...o, params: await o.authorize(url) })
  const tokens = await o.secrets.get<DropboxTokens>(name)
  if (!tokens) throw new RemoteError('auth', 'Dropbox tokens were not stored')
  return tokens
}
