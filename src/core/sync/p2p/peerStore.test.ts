import { describe, expect, test } from 'bun:test'
import { remoteContract } from '../../../../tests/contract/remote.contract'
import { virtualClock } from '../../ports/clock'
import { MemoryBucket, memoryRemote } from '../providers/memory'
import { type FrameChannel, MAX_FRAME, peerStore } from './peerStore'

interface FakeEnd extends FrameChannel {
  sent: number[]
  maxBuffered: number
}

/** Two connected in-memory channel ends with asynchronous delivery and a simulated send buffer. */
function fakeChannelPair(): [FakeEnd, FakeEnd] {
  let open = true
  const make = (): FakeEnd & { deliver?: (f: Uint8Array) => void; closeCbs: (() => void)[] } => {
    const frameCbs: ((f: Uint8Array) => void)[] = []
    const lowCbs: (() => void)[] = []
    const end = {
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      sent: [] as number[],
      maxBuffered: 0,
      closeCbs: [] as (() => void)[],
      deliver: (f: Uint8Array) => {
        for (const cb of frameCbs) cb(f)
      },
      send(frame: Uint8Array) {
        if (!open) throw new Error('channel closed')
        if (frame.length > MAX_FRAME) throw new Error('frame too large')
        end.sent.push(frame.length)
        end.bufferedAmount += frame.length
        end.maxBuffered = Math.max(end.maxBuffered, end.bufferedAmount)
        const copy = frame.slice()
        setTimeout(() => {
          end.bufferedAmount -= copy.length
          if (open) peer().deliver?.(copy)
          if (end.bufferedAmount <= end.bufferedAmountLowThreshold) for (const cb of lowCbs) cb()
        }, 0)
      },
      onFrame: (cb: (f: Uint8Array) => void) => frameCbs.push(cb),
      onBufferedLow: (cb: () => void) => lowCbs.push(cb),
      onClose: (cb: () => void) => end.closeCbs.push(cb),
      close() {
        if (!open) return
        open = false
        for (const cb of [...a.closeCbs, ...b.closeCbs]) cb()
      },
    }
    let peer = () => end
    return Object.assign(end, {
      link(p: () => typeof end) {
        peer = p
      },
    })
  }
  const a = make() as ReturnType<typeof make> & { link(p: () => unknown): void }
  const b = make() as ReturnType<typeof make> & { link(p: () => unknown): void }
  a.link(() => b)
  b.link(() => a)
  return [a, b]
}

remoteContract('peer(memory) over a fake channel', () => {
  const clock = virtualClock(1_000)
  const bucket = new MemoryBucket(clock)
  const [here, there] = fakeChannelPair()
  peerStore(there, { id: 'peer:there', serve: memoryRemote({ bucket }) })
  const store = peerStore(here, { id: 'peer:here' })
  return {
    store,
    duplicate: async (key, body) => {
      bucket.duplicate(key, body)
    },
    goOffline: () => here.close(),
    now: () => clock.now(),
    advance: (ms) => clock.advance(ms),
  }
})

describe('peerStore', () => {
  test('large bodies travel in frames of at most 64 KB, with backpressure', async () => {
    const [here, there] = fakeChannelPair()
    peerStore(there, { id: 'there', serve: memoryRemote({ bucket: new MemoryBucket() }) })
    const store = peerStore(here, { id: 'here' })
    const body = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251)
    await store.put('blob/big', body)
    expect(Math.max(...here.sent)).toBeLessThanOrEqual(MAX_FRAME)
    expect(here.sent.length).toBeGreaterThan(48)
    expect(here.maxBuffered).toBeLessThan(1024 * 1024 + MAX_FRAME + 1)
    expect(await store.get({ key: 'blob/big' })).toEqual(body)
    expect(Math.max(...there.sent)).toBeLessThanOrEqual(MAX_FRAME)
  })

  test('both sides can serve and query over one channel', async () => {
    const [a, b] = fakeChannelPair()
    const ra = peerStore(a, { id: 'a', serve: memoryRemote({ bucket: new MemoryBucket() }) })
    const rb = peerStore(b, { id: 'b', serve: memoryRemote({ bucket: new MemoryBucket() }) })
    await Promise.all([ra.put('x', new Uint8Array([1])), rb.put('x', new Uint8Array([2]))])
    expect(await ra.get({ key: 'x' })).toEqual(new Uint8Array([1]))
    expect(await rb.get({ key: 'x' })).toEqual(new Uint8Array([2]))
  })

  test('a device that does not share refuses with a permission error', async () => {
    const [a, b] = fakeChannelPair()
    peerStore(b, { id: 'b' })
    const ra = peerStore(a, { id: 'a' })
    await expect(ra.get({ key: 'x' })).rejects.toMatchObject({ kind: 'permission' })
  })

  test('closing mid-request rejects with a network error', async () => {
    const [a, b] = fakeChannelPair()
    peerStore(b, { id: 'b', serve: memoryRemote({ bucket: new MemoryBucket() }) })
    const ra = peerStore(a, { id: 'a' })
    const pending = ra.put('k', new Uint8Array(512 * 1024))
    ra.close()
    await expect(pending).rejects.toMatchObject({ kind: 'network' })
  })
})
