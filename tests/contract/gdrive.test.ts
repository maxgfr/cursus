import { virtualClock } from '../../src/core/ports/clock'
import { memoryStore } from '../../src/core/storage/memoryStore'
import { secretsVault } from '../../src/core/storage/secrets'
import { gdriveRemote } from '../../src/core/sync/providers/gdrive'
import { gdriveTokens } from '../../src/core/sync/providers/gdriveAuth'
import { FakeGoogle } from '../support/fakeGoogle'
import { remoteContract } from './remote.contract'

async function fixture(o: { pageSize?: number }) {
  const clock = virtualClock(Date.UTC(2026, 0, 1))
  const google = new FakeGoogle({ clock, clientSecret: 'device-secret' })
  const secrets = secretsVault(memoryStore())
  await secrets.set('gdrive', {
    clientId: google.clientId,
    clientSecret: 'device-secret',
    refreshToken: google.grant(),
  })
  const tokens = gdriveTokens({ fetch: google.fetch, clock, secrets, secretName: 'gdrive' })
  const store = gdriveRemote({ fetch: google.fetch, tokens, rootName: 'Cursus', pageSize: o.pageSize })
  return {
    store,
    duplicate: async (key: string, body: Uint8Array) => {
      const [root] = await store.roots()
      google.addFile({ name: key, parents: [root as string], bytes: body })
    },
    goOffline: () => {
      google.offline = true
    },
    now: () => clock.now(),
    advance: (ms: number) => {
      clock.advance(ms)
    },
  }
}

remoteContract('gdrive (fake Google)', () => fixture({}))
remoteContract('gdrive (fake Google), page size 2', () => fixture({ pageSize: 2 }))
