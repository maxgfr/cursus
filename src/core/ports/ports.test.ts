import { describe, expect, test } from 'bun:test'
import { systemClock, virtualClock } from './clock'
import { defaultLocks, memoryLocks, webLocks } from './locks'
import { cryptoRng, seededRng } from './rng'

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('clock', () => {
  test('systemClock follows Date.now', () => {
    const before = Date.now()
    const t = systemClock.now()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
  })
  test('virtualClock advances and sets, never backwards', () => {
    const c = virtualClock(1000)
    expect(c.now()).toBe(1000)
    expect(c.advance(500)).toBe(1500)
    c.set(42)
    expect(c.now()).toBe(42)
    expect(() => c.advance(-1)).toThrow(RangeError)
  })
})

describe('rng', () => {
  test('seededRng is deterministic per seed', () => {
    const a = seededRng(7)
    const b = seededRng(7)
    const c = seededRng(8)
    const xs = Array.from({ length: 5 }, () => a.u32())
    expect(Array.from({ length: 5 }, () => b.u32())).toEqual(xs)
    expect(Array.from({ length: 5 }, () => c.u32())).not.toEqual(xs)
    for (const x of xs) expect(x >>> 0).toBe(x)
  })
  test('ids are ULIDs encoding the clock time', () => {
    const clock = virtualClock(1_700_000_000_000)
    const r = seededRng(1, clock)
    const id1 = r.id()
    clock.advance(1)
    const id2 = r.id()
    expect(id1).toMatch(ULID)
    expect(id2 > id1).toBe(true)
    expect(seededRng(1, virtualClock(1_700_000_000_000)).id()).toBe(id1)
    expect(seededRng(1).id().slice(0, 10)).toBe('0000000000')
  })
  test('cryptoRng yields unique ULIDs and u32 values', () => {
    const r = cryptoRng()
    const ids = new Set(Array.from({ length: 100 }, () => r.id()))
    expect(ids.size).toBe(100)
    for (const id of ids) expect(id).toMatch(ULID)
    const x = r.u32()
    expect(Number.isInteger(x) && x >= 0 && x < 2 ** 32).toBe(true)
  })
})

describe('locks', () => {
  test('memoryLocks serialises runs of the same name in order', async () => {
    const locks = memoryLocks()
    const log: string[] = []
    const job = (tag: string) =>
      locks.run('a', async () => {
        log.push(`${tag}+`)
        await Bun.sleep(5)
        log.push(`${tag}-`)
        return tag
      })
    const results = await Promise.all([job('1'), job('2'), job('3')])
    expect(results).toEqual(['1', '2', '3'])
    expect(log).toEqual(['1+', '1-', '2+', '2-', '3+', '3-'])
  })
  test('ifAvailable returns null while held, runs when free', async () => {
    const locks = memoryLocks()
    let release = () => {}
    const holding = locks.run('a', () => new Promise<string>((r) => (release = () => r('held'))))
    expect(await locks.run('a', async () => 'x', { ifAvailable: true })).toBeNull()
    expect(await locks.run('b', async () => 'other', { ifAvailable: true })).toBe('other')
    release()
    expect(await holding).toBe('held')
    expect(await locks.run('a', async () => 'free', { ifAvailable: true })).toBe('free')
  })
  test('a throwing holder releases the lock', async () => {
    const locks = memoryLocks()
    await expect(locks.run('a', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await locks.run('a', async () => 1, { ifAvailable: true })).toBe(1)
  })
  test('webLocks maps an unavailable lock to null', async () => {
    const manager = {
      request<T>(_n: string, o: { ifAvailable?: boolean }, cb: (lock: unknown) => Promise<T>) {
        return cb(o.ifAvailable ? null : {})
      },
    }
    const locks = webLocks(manager)
    expect(await locks.run('a', async () => 'ok')).toBe('ok')
    expect(await locks.run('a', async () => 'ok', { ifAvailable: true })).toBeNull()
  })
  test('defaultLocks falls back to memory without navigator.locks', async () => {
    expect(await defaultLocks(undefined).run('a', async () => 2)).toBe(2)
    expect(await defaultLocks({}).run('a', async () => 3)).toBe(3)
    let used = false
    const manager = {
      request<T>(_n: string, _o: { ifAvailable?: boolean }, cb: (lock: unknown) => Promise<T>) {
        used = true
        return cb({})
      },
    }
    expect(await defaultLocks({ locks: manager }).run('a', async () => 4)).toBe(4)
    expect(used).toBe(true)
    expect(await defaultLocks().run('a', async () => 5)).toBe(5)
  })
})
