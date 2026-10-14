import { describe, expect, test } from 'bun:test'
import { all, world } from './harness.test'
import { confirmByListing, dirOf, planListing, runListing, watermarks } from './listing'

const seg = (dev: string, seq: number) => `seg/${dev}/${String(seq).padStart(10, '0')}-0123456789abcdef.seg`

describe('watermarks', () => {
  test('highest contiguous seq per device; -1 while seq 0 is unseen', () => {
    const wm = watermarks([seg('A', 0), seg('A', 1), seg('A', 3), seg('B', 1), 'fmt/v1', 'garbage'])
    expect(wm.get('A')).toBe(1)
    expect(wm.get('B')).toBe(-1)
    expect(wm.has('C')).toBe(false)
  })
})

describe('planListing', () => {
  test('full and none modes list everything', () => {
    expect(planListing({ full: true, mode: 'start-after', known: [] })).toEqual({ full: true, calls: [{ prefix: '' }] })
    expect(planListing({ full: false, mode: 'none', known: [] }).full).toBe(true)
  })
  test('start-after: small prefixes, per-device watermarks, gaps between known devices', () => {
    const p = planListing({ full: false, mode: 'start-after', known: [seg('B', 0), seg('B', 1), seg('D', 2)] })
    expect(p.full).toBe(false)
    expect(p.calls).toEqual([
      { prefix: 'keys/' },
      { prefix: 'ws/' },
      { prefix: 'ckpt/' },
      { prefix: 'seg/B/', startAfter: 'seg/B/0000000001' },
      { prefix: 'seg/D/' },
      { prefix: 'seg/', until: 'seg/B/' },
      { prefix: 'seg/', startAfter: 'seg/B/~', until: 'seg/D/' },
      { prefix: 'seg/', startAfter: 'seg/D/~' },
    ])
    expect(planListing({ full: false, mode: 'start-after', known: [] }).calls.at(-1)).toEqual({ prefix: 'seg/' })
  })
  test('created-after looks back 15 minutes; full when never listed', () => {
    const p = planListing({ full: false, mode: 'created-after', known: [], lastListedAt: 1_000_000 })
    expect(p.calls).toEqual([{ prefix: 'keys/' }, { prefix: 'ws/' }, { prefix: '', createdAfter: 100_000 }])
    expect(planListing({ full: false, mode: 'created-after', known: [] }).full).toBe(true)
  })
})

describe('runListing', () => {
  test('keeps duplicates by handle, drops mangled names, honours until and abort', async () => {
    const w = world()
    const r = w.remote('x', 1)
    for (const k of [seg('A', 0), seg('B', 0), 'seg/A/0000000000-0123456789abcdef 2.seg', 'mirror/a.md']) {
      await r.put(k, new Uint8Array([1]))
    }
    w.bucket.duplicate(`x/${seg('A', 0)}`, new Uint8Array([2]))
    const l = await runListing(r, { full: true, calls: [{ prefix: '' }, { prefix: 'seg/' }] })
    expect(l.entries.get(seg('A', 0))?.length).toBe(2)
    expect(l.ignored).toBe(3)
    const partial = await runListing(r, { full: false, calls: [{ prefix: 'seg/', until: 'seg/B/' }] }, { pageSize: 1 })
    expect([...partial.entries.keys()]).toEqual([seg('A', 0)])
    const ac = new AbortController()
    ac.abort()
    await expect(runListing(r, { full: true, calls: [{ prefix: '' }] }, { signal: ac.signal })).rejects.toThrow()
    expect((await all(r.list(''))).length).toBe(5)
  })

  test('confirmByListing sees exactly the wanted keys present', async () => {
    const w = world()
    const r = w.remote()
    await r.put(seg('A', 1), new Uint8Array())
    await r.put(seg('A', 2), new Uint8Array())
    await r.put('fmt/v1', new Uint8Array())
    const seen = await confirmByListing(r, [seg('A', 2), seg('A', 5), 'fmt/v1', `bman/${'a'.repeat(64)}`])
    expect([...seen].sort()).toEqual(['fmt/v1', seg('A', 2)])
    expect(dirOf(seg('A', 1))).toBe('seg/A/')
    expect(dirOf('fmt/v1')).toBe('fmt/')
  })
})
