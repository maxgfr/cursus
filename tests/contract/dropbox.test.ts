import { afterAll } from 'bun:test'
import { virtualClock } from '../../src/core/ports/clock'
import { dropboxRemote } from '../../src/core/sync/providers/dropbox'
import { FakeDropbox } from '../support/fakeDropbox'
import { remoteContract } from './remote.contract'

const stops: (() => void)[] = []
afterAll(() => {
  for (const s of stops) s()
})

const tokens = (fake: FakeDropbox) => ({
  token: async () => fake.accessToken,
  refresh: async () => fake.accessToken,
})

remoteContract('dropbox (fake over Bun.serve)', () => {
  const clock = virtualClock(1_700_000_000_000)
  const fake = new FakeDropbox(clock)
  const { url, stop } = fake.serve()
  stops.push(stop)
  return {
    store: dropboxRemote({ fetch, tokens: tokens(fake), clock, root: 'cursus', apiBase: url, contentBase: url }),
    goOffline: () => stop(),
    now: () => clock.now(),
    advance: (ms) => clock.advance(ms),
  }
})

remoteContract('dropbox at the app folder root, small uploads through sessions', () => {
  const clock = virtualClock(1_700_000_000_000)
  const fake = new FakeDropbox(clock)
  return {
    store: dropboxRemote({ fetch: fake.fetch, tokens: tokens(fake), clock, uploadLimit: 4, chunkSize: 3 }),
    goOffline: () => {
      fake.offline = true
    },
    now: () => clock.now(),
    advance: (ms) => clock.advance(ms),
  }
})
