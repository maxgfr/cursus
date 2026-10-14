import { virtualClock } from '../../src/core/ports/clock'
import { faultyRemote } from '../../src/core/sync/providers/faulty'
import { MemoryBucket, memoryRemote } from '../../src/core/sync/providers/memory'
import { remoteContract } from './remote.contract'

remoteContract('memory', () => {
  const clock = virtualClock(1_000)
  const bucket = new MemoryBucket(clock)
  return {
    store: memoryRemote({ bucket, prefix: 'root' }),
    duplicate: async (key, body) => {
      bucket.duplicate(`root/${key}`, body)
    },
    now: () => clock.now(),
    advance: (ms) => clock.advance(ms),
  }
})

remoteContract('memory without prefix, page size 2', () => {
  const clock = virtualClock(0)
  return {
    store: memoryRemote({ bucket: new MemoryBucket(clock), pageSize: 2 }),
    now: () => clock.now(),
    advance: (ms) => clock.advance(ms),
  }
})

remoteContract('faulty(memory) with no fault injected', () => {
  const clock = virtualClock(5_000)
  const bucket = new MemoryBucket(clock)
  const store = faultyRemote(memoryRemote({ bucket }), { pageSize: 2 })
  return {
    store,
    duplicate: async (key, body) => {
      bucket.duplicate(key, body)
    },
    goOffline: () => {
      store.offline = true
    },
    now: () => clock.now(),
    advance: (ms) => clock.advance(ms),
  }
})
