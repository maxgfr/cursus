import { afterAll } from 'bun:test'
import { cloudkitRemote } from '../../src/core/sync/providers/cloudkit'
import { FakeCloudKit } from '../support/fakeCloudKit'
import { remoteContract } from './remote.contract'

const servers: { stop(force?: boolean): void }[] = []
afterAll(() => {
  for (const s of servers) s.stop(true)
})

function fixture(pageSize?: number) {
  const fake = new FakeCloudKit()
  const server = Bun.serve({ port: 0, fetch: fake.handle })
  servers.push(server)
  fake.origin = `http://localhost:${server.port}`
  let offline = false
  const store = cloudkitRemote({
    container: 'iCloud.io.github.cursus',
    apiToken: fake.apiToken,
    auth: { token: async () => 'user-token', invalidate: async () => {} },
    endpoint: fake.origin,
    pageSize,
    fetch: (url, init) => (offline ? Promise.reject(new TypeError('Failed to fetch')) : fetch(url, init)),
  })
  return {
    store,
    goOffline: () => {
      offline = true
    },
    now: fake.now,
    advance: fake.advance,
  }
}

remoteContract('cloudkit (fake over Bun.serve)', () => fixture())
remoteContract('cloudkit, page size 2', () => fixture(2))
