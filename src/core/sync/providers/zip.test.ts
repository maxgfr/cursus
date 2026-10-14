import { describe, expect, test } from 'bun:test'
import { unzipSync, zipSync } from 'fflate'
import { remoteContract } from '../../../../tests/contract/remote.contract'
import { RemoteError } from '../../contracts/errors'
import type { Entry } from '../../contracts/remote'
import { MemoryBucket, memoryRemote } from './memory'
import { archiveKeys, exportArchive, importArchive, README, README_NAME, ZipFormatError, zipStore } from './zip'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

async function all(it: AsyncIterable<Entry>): Promise<string[]> {
  const out: string[] = []
  for await (const e of it) out.push(e.key)
  return out
}

remoteContract('zip', () => ({ store: zipStore() }))

describe('zipStore', () => {
  test('round-trips through bytes, with a README that is not a key', async () => {
    const z = zipStore({ label: 'backup' })
    await z.put('fmt/v1', bytes('cursus/1\n'))
    await z.put('seg/d/0000000000-0123456789abcdef.seg', new Uint8Array([1, 2, 255]))
    const raw = z.toBytes()
    expect(new TextDecoder().decode(unzipSync(raw)[README_NAME])).toBe(README)
    const back = zipStore({ bytes: raw })
    expect(back.size).toBe(2)
    expect(await all(back.list(''))).toEqual(['fmt/v1', 'seg/d/0000000000-0123456789abcdef.seg'])
    expect(await back.get({ key: 'seg/d/0000000000-0123456789abcdef.seg' })).toEqual(new Uint8Array([1, 2, 255]))
    expect(back.toBytes()).toEqual(raw)
  })

  test('keys are immutable: same bytes is a no-op, different bytes is refused', async () => {
    const z = zipStore()
    await z.put('ws/01', bytes('a'))
    await z.put('ws/01', bytes('a'))
    await expect(z.put('ws/01', bytes('b'))).rejects.toBeInstanceOf(RemoteError)
    await expect(z.put('ws/01', bytes('ab'))).rejects.toBeInstanceOf(RemoteError)
    expect(await z.get({ key: 'ws/01' })).toEqual(bytes('a'))
  })

  test('garbage is a format error; directory entries are skipped', () => {
    expect(() => zipStore({ bytes: bytes('not a zip') })).toThrow(ZipFormatError)
    const raw = zipSync({ 'seg/': new Uint8Array(), 'fmt/v1': bytes('x') })
    expect(zipStore({ bytes: raw }).size).toBe(1)
  })
})

describe('archives', () => {
  function remote() {
    const bucket = new MemoryBucket()
    return { bucket, store: memoryRemote({ bucket }) }
  }

  test('full export skips mirror/, incremental export only carries new keys', async () => {
    const { store } = remote()
    await store.put('fmt/v1', bytes('cursus/1\n'))
    await store.put('seg/a/1', bytes('one'))
    await store.put('mirror/Bio/cards.csv', bytes('derived'))
    const full = await exportArchive(store)
    expect(full.keys).toEqual(['fmt/v1', 'seg/a/1'])
    const seen = await archiveKeys(full.bytes)
    await store.put('seg/a/2', bytes('two'))
    const inc = await exportArchive(store, { exclude: seen })
    expect(inc.keys).toEqual(['seg/a/2'])
    expect([...(await archiveKeys(inc.bytes))]).toEqual(['seg/a/2'])
  })

  test('a vanished key during export is an error, not a silent gap', async () => {
    const { store } = remote()
    await store.put('seg/a/1', bytes('one'))
    const flaky = { ...store, get: async () => null }
    await expect(exportArchive(flaky)).rejects.toBeInstanceOf(RemoteError)
  })

  test('duplicates (same key, several handles) are archived once', async () => {
    const { bucket, store } = remote()
    await store.put('bman/x', bytes('one'))
    bucket.duplicate('bman/x', bytes('two'))
    expect((await exportArchive(store)).keys).toEqual(['bman/x'])
  })

  test('importing an old backup after newer edits is a pure union and loses nothing', async () => {
    const { store } = remote()
    await store.put('fmt/v1', bytes('cursus/1\n'))
    await store.put('seg/a/1', bytes('one'))
    const old = await exportArchive(store)
    await store.put('seg/a/2', bytes('two'))
    await store.put('seg/b/1', bytes('other device'))

    const other = remote()
    await other.store.put('seg/c/1', bytes('only here'))
    expect(await importArchive(old.bytes, other.store)).toEqual({ added: 2, skipped: 0 })
    const newer = await exportArchive(store, { exclude: await archiveKeys(old.bytes) })
    expect(await importArchive(newer.bytes, other.store)).toEqual({ added: 2, skipped: 0 })

    expect(await importArchive(old.bytes, store)).toEqual({ added: 0, skipped: 2 })
    expect(await all(store.list(''))).toEqual(['fmt/v1', 'seg/a/1', 'seg/a/2', 'seg/b/1'])
    expect(await store.get({ key: 'seg/a/2' })).toEqual(bytes('two'))
    expect(await all(other.store.list(''))).toEqual(['fmt/v1', 'seg/a/1', 'seg/a/2', 'seg/b/1', 'seg/c/1'])
  })

  test('mirror/ entries in a foreign archive are ignored on import', async () => {
    const raw = zipSync({ 'mirror/x.md': bytes('x'), 'seg/a/1': bytes('1') })
    const { store } = remote()
    expect(await importArchive(raw, store)).toEqual({ added: 1, skipped: 1 })
  })
})
