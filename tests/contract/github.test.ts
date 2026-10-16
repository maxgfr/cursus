import { afterAll } from 'bun:test'
import { virtualClock } from '../../src/core/ports/clock'
import { githubRemote } from '../../src/core/sync/providers/github'
import { virtualTimers } from '../../src/core/sync/scheduler'
import { FakeGitHub } from '../support/fakeGitHub'
import { remoteContract } from './remote.contract'

const stops: (() => void)[] = []
afterAll(() => {
  for (const s of stops) s()
})

function fixture(fake: FakeGitHub, o: { url?: string; stop?: () => void; root?: string; maxTreeBytes?: number } = {}) {
  const clock = virtualClock(1_700_000_000_000)
  const store = githubRemote({
    owner: fake.owner,
    repo: fake.repo,
    token: fake.token,
    root: o.root,
    fetch: o.url ? (url, init) => fetch(url, init) : fake.fetch,
    apiBase: o.url,
    timers: virtualTimers(clock),
    now: () => clock.now(),
    maxTreeBytes: o.maxTreeBytes,
  })
  return {
    store,
    goOffline: () => {
      if (o.stop) o.stop()
      else fake.offline = true
    },
    now: () => clock.now(),
    advance: (ms: number) => clock.advance(ms),
  }
}

remoteContract('github (fake over Bun.serve)', () => {
  const fake = new FakeGitHub()
  const { url, stop } = fake.serve()
  stops.push(stop)
  return fixture(fake, { url, stop })
})

remoteContract('github, empty repository bootstrapped on the first write', () =>
  fixture(new FakeGitHub({ empty: true })),
)

remoteContract('github, truncated tree listings and tiny trees, nested folder', () => {
  const fake = new FakeGitHub()
  fake.truncateAt = 2
  return fixture(fake, { root: 'backups/cursus', maxTreeBytes: 8 })
})
