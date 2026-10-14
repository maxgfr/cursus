import { describe, expect, test } from 'bun:test'
import type { Entry, RemoteStore } from '../../src/core/contracts/remote'

export interface RemoteFixture {
  store: RemoteStore
  /** Stores a second object under an existing name, when the provider can have duplicates (Drive). */
  duplicate?: (key: string, body: Uint8Array) => Promise<void>
  /** Makes the next operation fail the way the provider does without network. */
  goOffline?: () => void
  /** Server time, for createdAfter. */
  now?: () => number
  advance?: (ms: number) => void
}

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

async function all(it: AsyncIterable<Entry>): Promise<Entry[]> {
  const out: Entry[] = []
  for await (const e of it) out.push(e)
  return out
}

/** Contract every RemoteStore implementation passes (memory here; fs, S3, Drive, Dropbox, CloudKit later). */
export function remoteContract(label: string, make: () => Promise<RemoteFixture> | RemoteFixture): void {
  describe(`RemoteStore contract: ${label}`, () => {
    test('put then get round-trips bytes; get of a missing key is null (certain 404)', async () => {
      const { store } = await make()
      await store.put('seg/dev/0000000000-0123456789abcdef.seg', bytes('hello'))
      const [e] = await all(store.list('seg/'))
      expect(e?.key).toBe('seg/dev/0000000000-0123456789abcdef.seg')
      expect(await store.get(e as Entry)).toEqual(bytes('hello'))
      expect(await store.get({ key: 'seg/dev/0000000000-0123456789abcdef.seg' })).toEqual(bytes('hello'))
      expect(await store.get({ key: 'seg/dev/0000000001-0123456789abcdef.seg' })).toBeNull()
    })

    test('empty bodies are kept', async () => {
      const { store } = await make()
      await store.put('ws/01EMPTY', new Uint8Array())
      expect(await store.get({ key: 'ws/01EMPTY' })).toEqual(new Uint8Array())
    })

    test('put is idempotent per key', async () => {
      const { store } = await make()
      await store.put('fmt/v1', bytes('cursus/1\n'))
      await store.put('fmt/v1', bytes('cursus/1\n'))
      const listed = await all(store.list(''))
      expect(listed.map((e) => e.key)).toEqual(['fmt/v1'])
      expect(await store.get({ key: 'fmt/v1' })).toEqual(bytes('cursus/1\n'))
    })

    test('list filters by prefix, in key order, every key once whatever the page size', async () => {
      const { store } = await make()
      const keys = Array.from({ length: 7 }, (_, i) => `seg/d/${String(i).padStart(10, '0')}-0123456789abcdef.seg`)
      for (const k of [...keys].reverse()) await store.put(k, bytes(k))
      await store.put('ckpt/d/0123456789abcdef.ckpt', bytes('c'))
      for (const pageSize of [1, 2, 3, 7, 100]) {
        const got = (await all(store.list('seg/', { pageSize }))).map((e) => e.key)
        expect(got).toEqual(keys)
      }
      expect((await all(store.list('ckpt/'))).map((e) => e.key)).toEqual(['ckpt/d/0123456789abcdef.ckpt'])
      expect(await all(store.list('nothing/'))).toEqual([])
    })

    test('startAfter skips keys up to and including it', async () => {
      const { store } = await make()
      for (const k of ['seg/a/1', 'seg/a/2', 'seg/b/1', 'seg/c/1']) await store.put(k, bytes(k))
      const got = (await all(store.list('seg/', { startAfter: 'seg/a/2', pageSize: 1 }))).map((e) => e.key)
      expect(got).toEqual(['seg/b/1', 'seg/c/1'])
      expect((await all(store.list('seg/', { startAfter: 'seg/a/~' }))).map((e) => e.key)).toEqual([
        'seg/b/1',
        'seg/c/1',
      ])
    })

    test('special keys: unicode, spaces, plus and percent signs, deep paths', async () => {
      const { store } = await make()
      const special = ['mirror/Cours é/fiche 1.md', 'mirror/a+b%20c/ü ß.csv', `keys/${'ab'.repeat(32)}.json`]
      for (const k of special) await store.put(k, bytes(k))
      for (const k of special) expect(await store.get({ key: k })).toEqual(bytes(k))
      expect((await all(store.list('mirror/'))).map((e) => e.key)).toEqual(special.slice(0, 2).sort())
    })

    test('duplicates: every copy is listed with its own handle and readable by handle', async () => {
      const f = await make()
      if (!f.duplicate) {
        // Providers without duplicates must never list the same handle twice.
        await f.store.put('bman/x', bytes('one'))
        const listed = await all(f.store.list('bman/'))
        expect(new Set(listed.map((e) => `${e.key}|${e.handle}`)).size).toBe(listed.length)
        return
      }
      await f.store.put('bman/x', bytes('one'))
      await f.duplicate('bman/x', bytes('two'))
      const listed = await all(f.store.list('bman/', { pageSize: 1 }))
      expect(listed.map((e) => e.key)).toEqual(['bman/x', 'bman/x'])
      expect(new Set(listed.map((e) => e.handle)).size).toBe(2)
      const bodies = await Promise.all(listed.map((e) => f.store.get(e)))
      expect(bodies.map((b) => new TextDecoder().decode(b ?? new Uint8Array())).sort()).toEqual(['one', 'two'])
    })

    test('createdAfter returns at least everything created after the given time', async () => {
      const f = await make()
      await f.store.put('seg/a/old', bytes('old'))
      const t = f.now?.() ?? 0
      f.advance?.(1000)
      await f.store.put('seg/a/new', bytes('new'))
      const got = (await all(f.store.list('seg/', { createdAfter: t }))).map((e) => e.key)
      expect(got).toContain('seg/a/new')
    })

    test('failures are errors, never a null that would read as "absent"', async () => {
      const f = await make()
      if (!f.goOffline) return
      await f.store.put('fmt/v1', bytes('x'))
      f.goOffline()
      await expect(f.store.get({ key: 'fmt/v1' })).rejects.toBeDefined()
      await expect(f.store.put('fmt/v1', bytes('x'))).rejects.toBeDefined()
      await expect(all(f.store.list(''))).rejects.toBeDefined()
    })
  })
}
