import { afterAll } from 'bun:test'
import { virtualClock } from '../../src/core/ports/clock'
import { onedriveRemote } from '../../src/core/sync/providers/onedrive'
import { FakeOneDrive } from '../support/fakeOneDrive'
import { remoteContract } from './remote.contract'

const stops: (() => void)[] = []
afterAll(() => {
  for (const s of stops) s()
})

const tokens = (fake: FakeOneDrive) => ({
  token: async () => fake.accessToken,
  refresh: async () => fake.accessToken,
})

remoteContract('onedrive (fake Graph over Bun.serve)', () => {
  const clock = virtualClock(1_700_000_000_000)
  const fake = new FakeOneDrive(() => clock.now())
  const { url, stop } = fake.serve()
  stops.push(stop)
  return {
    store: onedriveRemote({ fetch, tokens: tokens(fake), root: 'cursus', graphBase: url }),
    goOffline: () => stop(),
    now: () => clock.now(),
    advance: (ms) => clock.advance(ms),
  }
})

remoteContract('onedrive at the app folder root, small uploads through sessions', () => {
  const clock = virtualClock(1_700_000_000_000)
  const fake = new FakeOneDrive(() => clock.now())
  return {
    store: onedriveRemote({
      fetch: fake.fetch,
      tokens: tokens(fake),
      graphBase: 'https://graph.test',
      uploadLimit: 4,
      chunkSize: 3,
    }),
    goOffline: () => {
      fake.offline = true
    },
    now: () => clock.now(),
    advance: (ms) => clock.advance(ms),
  }
})
