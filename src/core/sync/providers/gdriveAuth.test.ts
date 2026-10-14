import { describe, expect, test } from 'bun:test'
import { FakeGoogle } from '../../../../tests/support/fakeGoogle'
import { RemoteError } from '../../contracts/errors'
import { virtualClock } from '../../ports/clock'
import { seededRng } from '../../ports/rng'
import { memoryStore } from '../../storage/memoryStore'
import { secretsVault } from '../../storage/secrets'
import {
  beginAuth,
  completeAuth,
  finishAuth,
  GDRIVE_SCOPE,
  type GDriveGrant,
  gdriveTokens,
  pendingName,
  pkceChallenge,
  startAuth,
} from './gdriveAuth'

const REDIRECT = 'https://example.github.io/cursus/oauth-callback.html'

function setup(o: { clientSecret?: string; tokenTtlS?: number } = {}) {
  const clock = virtualClock(Date.UTC(2026, 0, 1))
  const google = new FakeGoogle({ clock, clientSecret: o.clientSecret ?? 'device-secret', tokenTtlS: o.tokenTtlS })
  const secrets = secretsVault(memoryStore())
  const client = { clientId: google.clientId, clientSecret: o.clientSecret ?? 'device-secret' }
  return { clock, google, secrets, client }
}

async function kind(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(RemoteError)
    return (e as RemoteError).kind
  }
  throw new Error('expected a rejection')
}

describe('PKCE and consent URL', () => {
  test('S256 challenge is the unpadded base64url SHA-256 of the verifier', () => {
    // Expected values from `printf %s <verifier> | openssl dgst -sha256 -binary | base64`, made URL-safe.
    expect(pkceChallenge('dBjftJeZ4CVP-mJ92K1OKkmhqnuW-ZaoU8bodUkIYWQ')).toBe(
      'BCmGbUT9ZehnR4G8JwffollMfRMU5my0yGsZ6umHqBk',
    )
    expect(pkceChallenge('dBjftJeZ4CVP-mJ92K1OKkmhqnuW-ZaoU8bodUkIYQ')).toBe(
      '9AiLZrw7ZB-w-Thcq92dcr3Kdvcw031dkC0r0Qwn3sI',
    )
  })

  test('URL asks for offline access, drive.file and S256', () => {
    const p = startAuth({ client: { clientId: 'cid' }, redirectUri: REDIRECT, rng: seededRng(1), loginHint: 'a@b.c' })
    const u = new URL(p.url)
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const q = u.searchParams
    expect(q.get('client_id')).toBe('cid')
    expect(q.get('redirect_uri')).toBe(REDIRECT)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('scope')).toBe(GDRIVE_SCOPE)
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toBe(pkceChallenge(p.verifier))
    expect(q.get('state')).toBe(p.state)
    expect(q.get('login_hint')).toBe('a@b.c')
    expect(q.has('client_secret')).toBe(false)
    expect(p.verifier.length).toBeGreaterThanOrEqual(43)
    expect(p.state).not.toBe(startAuth({ client: { clientId: 'cid' }, redirectUri: REDIRECT, rng: seededRng(2) }).state)
  })
})

describe('redirect round trip', () => {
  test('beginAuth seals first, keeps state and verifier; finishAuth stores the grant in the vault', async () => {
    const { clock, google, secrets, client } = setup()
    const order: string[] = []
    const url = await beginAuth({
      client,
      redirectUri: REDIRECT,
      rng: seededRng(7),
      secrets: {
        ...secrets,
        set: async (n, v) => {
          order.push(`set ${n.split(':')[0]}`)
          await secrets.set(n, v)
        },
      },
      secretName: 'gdrive-dest',
      seal: async () => {
        order.push('seal')
      },
    })
    expect(order).toEqual(['seal', 'set gdrive-pending'])
    const q = new URL(url).searchParams
    const state = q.get('state') as string
    const code = google.consent({ challenge: q.get('code_challenge') as string, redirectUri: REDIRECT })
    const name = await finishAuth({ fetch: google.fetch, clock, secrets, client, params: { code, state } })
    expect(name).toBe('gdrive-dest')
    const g = await secrets.get<GDriveGrant>('gdrive-dest')
    expect(g?.refreshToken).toStartWith('refresh-')
    expect(g?.clientSecret).toBe('device-secret')
    expect(g?.expiresAt).toBe(clock.now() + 3600_000)
    expect(await secrets.get(pendingName(state))).toBeUndefined()
    // The state is single use.
    expect(await kind(finishAuth({ fetch: google.fetch, clock, secrets, client, params: { code, state } }))).toBe(
      'auth',
    )
  })

  test('callback errors are auth errors', async () => {
    const { clock, google, secrets, client } = setup()
    const go = async () => {
      const url = await beginAuth({
        client,
        redirectUri: REDIRECT,
        rng: seededRng(3),
        secrets,
        secretName: 'd',
        seal: async () => {},
      })
      return new URL(url).searchParams.get('state') as string
    }
    const f = (params: Record<string, string | undefined>) =>
      finishAuth({ fetch: google.fetch, clock, secrets, client, params })
    expect(await kind(f({ code: 'x' }))).toBe('auth')
    expect(await kind(f({ code: 'x', state: 'unknown' }))).toBe('auth')
    expect(await kind(f({ error: 'access_denied', state: await go() }))).toBe('auth')
    expect(await kind(f({ state: await go() }))).toBe('auth')
    // A code that does not match the verifier (or a reused one) is invalid_grant.
    expect(await kind(f({ code: 'code-forged', state: await go() }))).toBe('auth')
  })

  test('Google refuses the exchange without the per-device secret', async () => {
    const { clock, google } = setup()
    const p = startAuth({ client: { clientId: google.clientId }, redirectUri: REDIRECT, rng: seededRng(4) })
    const code = google.consent({ challenge: pkceChallenge(p.verifier), redirectUri: REDIRECT })
    const r = completeAuth({
      fetch: google.fetch,
      clock,
      client: { clientId: google.clientId },
      code,
      verifier: p.verifier,
      redirectUri: REDIRECT,
    })
    expect(await kind(r)).toBe('auth')
  })

  test('a token response without refresh token is an auth error', async () => {
    const { clock } = setup()
    const fetch = async () => new Response(JSON.stringify({ access_token: 'a', expires_in: 10 }), { status: 200 })
    const r = completeAuth({ fetch, clock, client: { clientId: 'c' }, code: 'c', verifier: 'v', redirectUri: REDIRECT })
    expect(await kind(r)).toBe('auth')
  })
})

describe('token source', () => {
  async function connected(o: { tokenTtlS?: number } = {}) {
    const s = setup(o)
    await s.secrets.set('g', { ...s.client, refreshToken: s.google.grant() })
    const tokens = gdriveTokens({ fetch: s.google.fetch, clock: s.clock, secrets: s.secrets, secretName: 'g' })
    return { ...s, tokens }
  }
  const tokenCalls = (g: FakeGoogle) => g.calls.filter((c) => c.url.includes('oauth2.googleapis.com')).length

  test('caches the access token until shortly before expiry, sharing one refresh', async () => {
    const { google, clock, tokens, secrets } = await connected()
    const [a, b] = await Promise.all([tokens.token(), tokens.token()])
    expect(a).toBe(b as string)
    expect(tokenCalls(google)).toBe(1)
    expect(await tokens.token()).toBe(a)
    expect((await secrets.get<GDriveGrant>('g'))?.accessToken).toBe(a)
    clock.advance(3600_000 - 30_000)
    expect(await tokens.token()).not.toBe(a)
    expect(tokenCalls(google)).toBe(2)
  })

  test('invalidate forces a refresh; a missing grant is left alone', async () => {
    const { google, tokens, secrets, clock } = await connected()
    const a = await tokens.token()
    await tokens.invalidate()
    expect((await secrets.get<GDriveGrant>('g'))?.accessToken).toBeUndefined()
    expect(await tokens.token()).not.toBe(a)
    expect(tokenCalls(google)).toBe(2)
    const other = gdriveTokens({ fetch: google.fetch, clock, secrets, secretName: 'none' })
    await other.invalidate()
    expect(await secrets.get('none')).toBeUndefined()
  })

  test('keeps a rotated refresh token', async () => {
    const { clock, secrets } = setup()
    await secrets.set('g', { clientId: 'c', refreshToken: 'old' })
    const fetch = async () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'new' }), { status: 200 })
    expect(await gdriveTokens({ fetch, clock, secrets, secretName: 'g' }).token()).toBe('a')
    const g = await secrets.get<GDriveGrant>('g')
    expect(g?.refreshToken).toBe('new')
    expect(g?.expiresAt).toBe(clock.now() + 3600_000)
  })

  test('invalid_grant (revoked) and no grant at all mean needs-auth', async () => {
    const { google, tokens, clock, secrets } = await connected()
    google.revokeAll()
    expect(await kind(tokens.token())).toBe('auth')
    expect(await kind(gdriveTokens({ fetch: google.fetch, clock, secrets, secretName: 'none' }).token())).toBe('auth')
    // The in-flight slot is released after a failure.
    expect(await kind(tokens.token())).toBe('auth')
  })

  test('token endpoint failures map to RemoteError kinds', async () => {
    const { google, tokens } = await connected()
    google.fail({ status: 429, reason: 'rate_limit', retryAfter: 3 })
    const e = await tokens.token().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(RemoteError)
    expect((e as RemoteError).kind).toBe('rate-limited')
    expect((e as RemoteError).retryAfterMs).toBe(3000)
    google.fail({ status: 403, reason: 'access_denied' })
    expect(await kind(tokens.token())).toBe('permission')
    google.fail({ status: 401, reason: 'unauthorized' })
    expect(await kind(tokens.token())).toBe('auth')
    google.fail({ status: 503 })
    expect(await kind(tokens.token())).toBe('network')
    google.offline = true
    expect(await kind(tokens.token())).toBe('network')
  })

  test('non-JSON answers: an error status keeps its kind, a 200 is a network error', async () => {
    const { clock, secrets } = setup()
    await secrets.set('g', { clientId: 'c', refreshToken: 'r' })
    const html = (status: number, retry?: string) => async () =>
      new Response('<html/>', { status, headers: retry === undefined ? {} : { 'retry-after': retry } })
    const t = (status: number, retry?: string) =>
      gdriveTokens({ fetch: html(status, retry), clock, secrets, secretName: 'g' }).token()
    expect(await kind(t(200))).toBe('network')
    expect(await kind(t(502))).toBe('network')
    const e = (await t(429, 'soon').catch((x: unknown) => x)) as RemoteError
    expect(e.kind).toBe('rate-limited')
    expect(e.retryAfterMs).toBeUndefined()
    const thrower = async (): Promise<Response> => {
      throw 'boom'
    }
    expect(await kind(gdriveTokens({ fetch: thrower, clock, secrets, secretName: 'g' }).token())).toBe('network')
  })
})
