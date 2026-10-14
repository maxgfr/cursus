import { virtualClock } from '../../src/core/ports/clock'
import { FsStore, memoryFsPersist } from '../../src/core/sync/providers/fs'
import { FakeDir } from '../support/fsHandle'
import { remoteContract } from './remote.contract'

for (const type of ['folder', 'icloud'] as const) {
  remoteContract(`fs (${type}, fake handle)`, () => {
    const clock = virtualClock(1_000)
    const root = new FakeDir('Cursus', { clock })
    return {
      store: new FsStore({ root, type, persist: memoryFsPersist() }),
      goOffline: () => {
        root.state.failWith = 'NotReadableError'
      },
      now: () => clock.now(),
      advance: (ms) => clock.advance(ms),
    }
  })
}
