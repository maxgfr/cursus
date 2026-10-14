import { test } from 'bun:test'
import { systemClock } from '../../src/core/ports/clock'
import { memoryStore } from '../../src/core/storage/memoryStore'
import { secretsVault } from '../../src/core/storage/secrets'
import { gdriveRemote } from '../../src/core/sync/providers/gdrive'
import { gdriveTokens } from '../../src/core/sync/providers/gdriveAuth'
import { remoteContract } from '../contract/remote.contract'

// Real Google Drive (drive.file scope). Each fixture uses its own, randomly named root folder.
const VARS = ['LIVE_GDRIVE_CLIENT_ID', 'LIVE_GDRIVE_CLIENT_SECRET', 'LIVE_GDRIVE_REFRESH_TOKEN']
const missing = VARS.filter((v) => !process.env[v])
const env = (name: string): string => process.env[name] ?? ''

if (missing.length > 0) {
  test.skip(`live Google Drive: skipped, set ${missing.join(', ')}`, () => {})
} else {
  remoteContract('gdrive (live)', async () => {
    let offline = false
    const doFetch = (input: string, init?: RequestInit): Promise<Response> =>
      offline ? Promise.reject(new TypeError('Failed to fetch')) : fetch(input, init)
    const secrets = secretsVault(memoryStore())
    await secrets.set('gdrive', {
      clientId: env('LIVE_GDRIVE_CLIENT_ID'),
      clientSecret: env('LIVE_GDRIVE_CLIENT_SECRET'),
      refreshToken: env('LIVE_GDRIVE_REFRESH_TOKEN'),
    })
    const tokens = gdriveTokens({ fetch: doFetch, clock: systemClock, secrets, secretName: 'gdrive' })
    const store = gdriveRemote({ fetch: doFetch, tokens, rootName: `cursus-live-${crypto.randomUUID()}` })
    return {
      store,
      goOffline: () => {
        offline = true
      },
    }
  })
}
