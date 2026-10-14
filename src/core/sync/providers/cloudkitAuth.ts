import { RemoteError } from '../../contracts/errors'
import type { Secrets } from '../../storage/secrets'
import type { CloudKitTokenSource, FetchFn } from './cloudkit'

/**
 * Apple ID sign-in for CloudKit Web Services, URL Redirect mode. `signInUrl` asks CloudKit for the
 * sign-in page (users/current answers 421 with a redirectURL); Apple sends the browser back to
 * oauth-callback.html, which drops `ckWebAuthToken` into IndexedDB. `token` picks it up from there once,
 * then keeps it in the secrets vault. AUTHENTICATION_REQUIRED later on drops it: the destination
 * shows "needs auth" until the user signs in again (never an automatic redirect).
 */
export interface CloudKitAuthOptions {
  container: string
  environment?: 'development' | 'production'
  apiToken: string
  secrets: Pick<Secrets, 'get' | 'set' | 'delete'>
  /** Takes (reads and clears) what oauth-callback.html stored, if anything. */
  takeCallbackParams: () => Promise<Record<string, string> | undefined>
  fetch: FetchFn
  endpoint?: string
}

export interface CloudKitAuth extends CloudKitTokenSource {
  /** Apple sign-in page to redirect to; null when the stored token is still valid. */
  signInUrl(): Promise<string | null>
  signOut(): Promise<void>
}

const DEFAULT_ENDPOINT = 'https://api.apple-cloudkit.com'

export const cloudkitSecretName = (container: string, env: string): string => `cloudkit-${container}-${env}`

export function cloudkitAuth(o: CloudKitAuthOptions): CloudKitAuth {
  const env = o.environment ?? 'production'
  const name = cloudkitSecretName(o.container, env)
  const base = `${(o.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')}/database/1/${encodeURIComponent(o.container)}/${env}/public`

  async function token(): Promise<string | null> {
    const stored = await o.secrets.get<string>(name)
    if (stored) return stored
    const fresh = (await o.takeCallbackParams())?.ckWebAuthToken
    if (!fresh) return null
    await o.secrets.set(name, fresh)
    return fresh
  }

  return {
    token,
    invalidate: () => o.secrets.delete(name),
    signOut: () => o.secrets.delete(name),
    async signInUrl() {
      const t = await token()
      let url = `${base}/users/current?ckAPIToken=${encodeURIComponent(o.apiToken)}`
      if (t) url += `&ckWebAuthToken=${encodeURIComponent(t)}`
      let res: Response
      try {
        res = await o.fetch(url, { method: 'GET' })
      } catch (e) {
        throw new RemoteError('network', `iCloud sign-in: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (res.ok) return null
      const body = (await res.json().catch(() => ({}))) as { redirectURL?: string; serverErrorCode?: string }
      if (res.status === 421 && body.redirectURL) {
        if (t) await o.secrets.delete(name)
        return body.redirectURL
      }
      const kind = res.status === 401 || res.status === 403 ? 'permission' : 'network'
      throw new RemoteError(kind, `iCloud sign-in: ${body.serverErrorCode ?? `HTTP ${res.status}`}`)
    },
  }
}
