import { test } from 'bun:test'
import type { Entry, Key, RemoteStore } from '../../src/core/contracts/remote'
import { cloudkitRemote } from '../../src/core/sync/providers/cloudkit'
import { remoteContract } from '../contract/remote.contract'

// Real CloudKit private database. Keys live in one flat namespace, so each fixture prefixes its keys.
const VARS = ['LIVE_CLOUDKIT_CONTAINER', 'LIVE_CLOUDKIT_API_TOKEN', 'LIVE_CLOUDKIT_WEB_AUTH_TOKEN']
const missing = VARS.filter((v) => !process.env[v])
const env = (name: string): string => process.env[name] ?? ''

/** The same store seen under `prefix`: keys are stored as `prefix + key` and listed without it. */
function prefixed(inner: RemoteStore, prefix: string): RemoteStore {
  return {
    id: `${inner.id}:${prefix}`,
    async *list(p, o) {
      const startAfter = o?.startAfter === undefined ? undefined : prefix + o.startAfter
      for await (const e of inner.list(prefix + p, { ...o, startAfter }))
        yield { ...e, key: e.key.slice(prefix.length) }
    },
    get: (e: Entry) => inner.get({ ...e, key: prefix + e.key }),
    put: (key: Key, body: Uint8Array) => inner.put(prefix + key, body),
  }
}

if (missing.length > 0) {
  test.skip(`live CloudKit: skipped, set ${missing.join(', ')}`, () => {})
} else {
  const environment = process.env.LIVE_CLOUDKIT_ENV === 'production' ? 'production' : 'development'
  remoteContract(`cloudkit (live, ${environment})`, () => {
    let offline = false
    const store = cloudkitRemote({
      container: env('LIVE_CLOUDKIT_CONTAINER'),
      environment,
      apiToken: env('LIVE_CLOUDKIT_API_TOKEN'),
      auth: { token: async () => env('LIVE_CLOUDKIT_WEB_AUTH_TOKEN'), invalidate: async () => {} },
      fetch: (url, init) => (offline ? Promise.reject(new TypeError('Failed to fetch')) : fetch(url, init)),
    })
    return {
      store: prefixed(store, `live-${crypto.randomUUID()}/`),
      goOffline: () => {
        offline = true
      },
    }
  })
}
