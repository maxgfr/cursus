import { test } from 'bun:test'
import { systemClock } from '../../src/core/ports/clock'
import { dropboxRemote } from '../../src/core/sync/providers/dropbox'
import { remoteContract } from '../contract/remote.contract'

// Real Dropbox (app-folder app). Each fixture uses a fresh random subfolder of the app folder.
const missing = ['LIVE_DROPBOX_TOKEN'].filter((v) => !process.env[v])

if (missing.length > 0) {
  test.skip(`live Dropbox: skipped, set ${missing.join(', ')}`, () => {})
} else {
  const token = process.env.LIVE_DROPBOX_TOKEN ?? ''
  remoteContract('dropbox (live)', () => {
    let offline = false
    const store = dropboxRemote({
      fetch: (input, init) => (offline ? Promise.reject(new TypeError('Failed to fetch')) : fetch(input, init)),
      tokens: { token: async () => token, refresh: async () => token },
      clock: systemClock,
      root: `cursus-live-${crypto.randomUUID()}`,
    })
    return {
      store,
      goOffline: () => {
        offline = true
      },
    }
  })
}
