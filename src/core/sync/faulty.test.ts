import { describe, expect, test } from 'bun:test'
import { RemoteError } from '../contracts/errors'
import { seededRng } from '../ports/rng'
import { all, world } from './harness.test'
import { faultyRemote } from './providers/faulty'

const b = (n: number) => new Uint8Array([n, n, n])

function setup() {
  const w = world()
  const inner = w.remote('f')
  const f = faultyRemote(inner, { retryAfterMs: 7000 })
  return { w, inner, f }
}

describe('FaultyStore', () => {
  test('put fails before storing, after storing, or is silently lost', async () => {
    const { w, f } = setup()
    f.inject('put-before')
    await expect(f.put('a', b(1))).rejects.toMatchObject({ kind: 'network' })
    expect(w.bucket.keys('f/')).toEqual([])
    f.inject('put-after')
    await expect(f.put('a', b(1))).rejects.toMatchObject({ kind: 'network' })
    expect(w.bucket.keys('f/')).toEqual(['f/a'])
    f.inject('put-lost')
    await f.put('b', b(2))
    expect(w.bucket.keys('f/')).toEqual(['f/a'])
    f.inject('put-corrupt')
    await f.put('c', b(3))
    expect(w.bucket.read('f/c')).not.toEqual(b(3))
    expect(f.fired).toEqual(['put-before', 'put-after', 'put-lost', 'put-corrupt'])
    expect(f.id).toBe(f.inner.id)
  })

  test('get: corrupt read once, network failure (never a null)', async () => {
    const { f } = setup()
    await f.put('a', b(1))
    f.inject('get-corrupt')
    expect(await f.get({ key: 'a' })).not.toEqual(b(1))
    expect(await f.get({ key: 'a' })).toEqual(b(1))
    f.inject('get-fail')
    await expect(f.get({ key: 'a' })).rejects.toBeInstanceOf(RemoteError)
    expect(await f.get({ key: 'missing' })).toBeNull()
    await f.put('e', new Uint8Array())
    f.inject('get-corrupt')
    expect((await f.get({ key: 'e' }))?.length).toBe(1)
  })

  test('list: pages omitted, duplicated, or failing', async () => {
    const { f } = setup()
    for (let i = 0; i < 6; i++) await f.put(`k${i}`, b(i))
    f.inject('list-omit')
    expect((await all(f.list('', { pageSize: 2 }))).map((e) => e.key)).toEqual(['k2', 'k3', 'k4', 'k5'])
    f.inject('list-dup')
    expect((await all(f.list('', { pageSize: 4 }))).length).toBe(10)
    f.inject('list-fail')
    await expect(all(f.list('', { pageSize: 2 }))).rejects.toMatchObject({ kind: 'network' })
    expect((await all(f.list(''))).length).toBe(6)
  })

  test('429 with Retry-After, expired auth until reauth, quota, offline', async () => {
    const { f } = setup()
    f.inject('rate-limit')
    await expect(f.put('a', b(1))).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 7000 })
    f.inject('auth')
    await expect(f.get({ key: 'a' })).rejects.toMatchObject({ kind: 'auth' })
    f.inject('quota')
    await expect(f.put('a', b(1))).rejects.toMatchObject({ kind: 'quota' })
    f.authExpired = true
    await expect(all(f.list(''))).rejects.toMatchObject({ kind: 'auth' })
    f.reauth()
    f.quotaFull = true
    await expect(f.put('a', b(1))).rejects.toMatchObject({ kind: 'quota' })
    expect(await f.get({ key: 'a' })).toBeNull()
    f.quotaFull = false
    f.offline = true
    await expect(f.get({ key: 'a' })).rejects.toMatchObject({ kind: 'network' })
    f.heal()
    await f.put('a', b(1))
    expect(await f.get({ key: 'a' })).toEqual(b(1))
  })

  test('random faults are deterministic for a seed; heal lifts everything', async () => {
    const run = async (seed: number) => {
      const { f } = setup()
      f.randomly(seededRng(seed), { 'put-lost': 0.5, 'get-fail': 0.3 })
      for (let i = 0; i < 20; i++) await f.put(`k${i}`, b(i))
      for (let i = 0; i < 20; i++) await f.get({ key: `k${i}` }).catch(() => null)
      f.inject('auth', 2)
      f.heal()
      await f.put('z', b(9))
      return f.fired.join(',')
    }
    expect(await run(4)).toBe(await run(4))
    expect(await run(4)).not.toBe(await run(5))
  })
})

describe('MemoryBucket extras', () => {
  test('server time, explicit deletion, corruption of empty objects', async () => {
    const { w, inner } = setup()
    expect(w.bucket.now()).toBe(w.clock.now())
    await inner.put('a', new Uint8Array())
    expect(w.bucket.corrupt('f/a')).toBe(true)
    expect(w.bucket.read('f/a')).toEqual(new Uint8Array([0]))
    expect(w.bucket.corrupt('f/none')).toBe(false)
    expect(w.bucket.read('f/a', 'nope')).toBeNull()
    await (inner as unknown as { delete(k: string): Promise<void> }).delete('a')
    expect(w.bucket.keys('f/')).toEqual([])
  })
})
