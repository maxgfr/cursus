import { describe, expect, test } from 'bun:test'
import { cloneableDir, FakeDir } from '../../../../tests/support/fsHandle'
import { RemoteError } from '../../contracts/errors'
import type { Entry } from '../../contracts/remote'
import { virtualClock } from '../../ports/clock'
import { idbStore } from '../../storage/idbStore'
import { FsStore, fsError, idbFsPersist, isConflictCopy, memoryFsPersist } from './fs'

const enc = new TextEncoder()
const b = (s: string) => enc.encode(s)
async function keys(it: AsyncIterable<Entry>): Promise<string[]> {
  const out: string[] = []
  for await (const e of it) out.push(e.key)
  return out
}

describe('FsStore', () => {
  test('stores keys as nested folders and files', async () => {
    const root = new FakeDir('Cursus')
    const s = new FsStore({ root, persist: memoryFsPersist() })
    await s.put('seg/dev/1.seg', b('x'))
    const seg = root.children.get('seg') as FakeDir
    expect(seg.kind).toBe('directory')
    expect((seg.children.get('dev') as FakeDir).children.has('1.seg')).toBe(true)
  })

  test('id depends on type and label, not on the handle object', () => {
    const a = new FsStore({ root: new FakeDir('X'), persist: memoryFsPersist() }).id
    expect(new FsStore({ root: new FakeDir('X'), persist: memoryFsPersist() }).id).toBe(a)
    expect(a.startsWith('folder-')).toBe(true)
    expect(
      new FsStore({ root: new FakeDir('X'), type: 'icloud', persist: memoryFsPersist() }).id.startsWith('icloud-'),
    ).toBe(true)
    expect(new FsStore({ root: new FakeDir('X'), label: 'Other', persist: memoryFsPersist() }).id).not.toBe(a)
  })

  test('ignores dotfiles and swap files when listing', async () => {
    const root = new FakeDir('Cursus')
    await root.writeFile('.DS_Store', b('junk'))
    await root.writeFile('seg/.seg.icloud', b('placeholder'))
    await root.writeFile('seg/a.crswap', b('swap'))
    const s = new FsStore({ root, persist: memoryFsPersist() })
    await s.put('seg/a', b('a'))
    expect(await keys(s.list(''))).toEqual(['seg/a'])
  })

  test('prunes folders that cannot match the prefix', async () => {
    const root = new FakeDir('Cursus')
    const s = new FsStore({ root, persist: memoryFsPersist() })
    for (const k of ['seg/a/1', 'seg/b/1', 'ckpt/a/1', 'segx/1']) await s.put(k, b(k))
    expect(await keys(s.list('seg/a'))).toEqual(['seg/a/1'])
    expect(await keys(s.list('seg'))).toEqual(['seg/a/1', 'seg/b/1', 'segx/1'])
  })

  test('rejects keys a folder cannot hold', async () => {
    const s = new FsStore({ root: new FakeDir('Cursus'), persist: memoryFsPersist() })
    for (const k of ['', 'a//b', 'a/../b', './a', 'a/.hidden', '/a', 'a/']) {
      await expect(s.put(k, b('x'))).rejects.toBeInstanceOf(RangeError)
      await expect(s.get({ key: k })).rejects.toBeInstanceOf(RangeError)
    }
  })

  test('a path through a file, or a folder where a file is expected, reads as absent', async () => {
    const root = new FakeDir('Cursus')
    const s = new FsStore({ root, persist: memoryFsPersist() })
    await s.put('a/b', b('x'))
    expect(await s.get({ key: 'a/b/c' })).toBeNull()
    expect(await s.get({ key: 'a' })).toBeNull()
    expect(await s.get({ key: 'z/b' })).toBeNull()
    await expect(s.put('a/b/c', b('y'))).rejects.toMatchObject({ kind: 'network' })
  })

  test('maps browser errors to RemoteError kinds', async () => {
    const root = new FakeDir('Cursus')
    const s = new FsStore({ root, persist: memoryFsPersist() })
    await s.put('k', b('x'))
    root.state.failWith = 'NotAllowedError'
    await expect(s.get({ key: 'k' })).rejects.toMatchObject({ kind: 'permission' })
    root.state.failWith = 'QuotaExceededError'
    await expect(s.put('k', b('x'))).rejects.toMatchObject({ kind: 'quota' })
    root.state.failWith = 'SecurityError'
    await expect(keys(s.list(''))).rejects.toMatchObject({ kind: 'permission' })
  })

  test('a failed write is aborted and leaves the previous content', async () => {
    const root = new FakeDir('Cursus')
    const s = new FsStore({ root, persist: memoryFsPersist() })
    await s.put('k', b('old'))
    const f = await root.getFileHandle('k')
    const w = await f.createWritable()
    root.state.failWith = 'QuotaExceededError'
    await expect(w.write(b('x'))).rejects.toBeDefined()
    root.state.failWith = undefined
    // Fail only the write step through fsRemote.
    const orig = f.createWritable.bind(f)
    f.createWritable = async () => {
      const real = await orig()
      return { ...real, write: async () => Promise.reject(new DOMException('full', 'QuotaExceededError')) }
    }
    await expect(s.put('k', b('new'))).rejects.toMatchObject({ kind: 'quota' })
    expect(await s.get({ key: 'k' })).toEqual(b('old'))
  })

  test('createdAfter uses the modification time', async () => {
    const clock = virtualClock(10)
    const s = new FsStore({ root: new FakeDir('Cursus', { clock }), persist: memoryFsPersist() })
    await s.put('a', b('a'))
    clock.advance(5)
    await s.put('b', b('b'))
    expect(await keys(s.list('', { createdAfter: 10 }))).toEqual(['b'])
    expect(await keys(s.list('', { startAfter: 'a' }))).toEqual(['b'])
  })

  test('fsError keeps RemoteErrors and handles non-Error values', () => {
    const r = new RemoteError('auth', 'x')
    expect(fsError(r, 'w')).toBe(r)
    expect(fsError('boom', 'w')).toMatchObject({ kind: 'network', message: 'w: boom' })
  })

  test('iCloud conflict copies are ignored, other odd names are kept', async () => {
    const seg = `seg/${'a'.repeat(26)}/0000000001-0123456789abcdef.seg`
    expect(isConflictCopy(seg)).toBe(false)
    expect(isConflictCopy(seg.replace('.seg', ' 2.seg'))).toBe(true)
    expect(isConflictCopy('fmt/v1 2')).toBe(true)
    expect(isConflictCopy('mirror/Cours 2.md')).toBe(false)
    const root = new FakeDir('Cursus')
    await root.writeFile(seg.replace('.seg', ' 2.seg'), b('copy'))
    await root.writeFile('mirror/Cours 2.md', b('note'))
    const s = new FsStore({ root, persist: memoryFsPersist() })
    expect(await keys(s.list(''))).toEqual(['mirror/Cours 2.md'])
  })

  test('lost permission is a permission error until granted again', async () => {
    const root = new FakeDir('Cursus')
    const s = new FsStore({ root, persist: memoryFsPersist() })
    await s.put('k', b('x'))
    root.state.permission = 'prompt'
    await expect(s.get({ key: 'k' })).rejects.toMatchObject({ kind: 'permission' })
    await expect(s.put('k', b('x'))).rejects.toMatchObject({ kind: 'permission' })
    await expect(keys(s.list(''))).rejects.toMatchObject({ kind: 'permission' })
    expect(await s.requestPermission()).toBe(true)
    expect(await s.get({ key: 'k' })).toEqual(b('x'))
    root.state.permission = 'denied'
    expect(await s.requestPermission()).toBe(false)
  })

  test('without the permission API access is assumed', async () => {
    const root = new FakeDir('Cursus')
    const bare = Object.assign(Object.create(root), { queryPermission: undefined, requestPermission: undefined })
    const s = new FsStore({ root: bare, persist: memoryFsPersist() })
    expect(await s.requestPermission()).toBe(true)
    await s.put('k', b('x'))
    expect(await s.get({ key: 'k' })).toEqual(b('x'))
  })

  test('the handle is kept and restored by destination id', async () => {
    const persist = memoryFsPersist()
    const root = new FakeDir('Cursus')
    const s = await FsStore.create({ root, persist, type: 'icloud' })
    await s.put('fmt/v1', b('x'))
    expect(await FsStore.restore('folder-0000000000000000', persist)).toBeNull()
    const again = await FsStore.restore(s.id, persist, { type: 'icloud' })
    expect(again?.id).toBe(s.id)
    expect(await again?.get({ key: 'fmt/v1' })).toEqual(b('x'))
  })

  test('the handle and absorbed hashes survive a reload through IndexedDB', async () => {
    const name = `cursus-fs-persist-${Date.now()}`
    const first = idbStore({ name })
    const s = await FsStore.create({ root: cloneableDir('Cursus'), persist: idbFsPersist(first) })
    await idbFsPersist(first).addAbsorbed(s.id, 'h1')
    first.close()
    const reopened = idbStore({ name })
    const persist = idbFsPersist(reopened)
    expect(await FsStore.restore('folder-0000000000000000', persist)).toBeNull()
    expect((await persist.loadHandle(s.id))?.name).toBe('Cursus')
    expect((await FsStore.restore(s.id, persist))?.id).toBe(s.id)
    expect([...(await persist.absorbed(s.id))]).toEqual(['h1'])
    await persist.addAbsorbed(s.id, 'h2')
    expect([...(await persist.absorbed(s.id))].sort()).toEqual(['h1', 'h2'])
    expect([...(await persist.absorbed('folder-0000000000000000'))]).toEqual([])
    reopened.close()
  })

  test('absorbs inbox/*.cursus once per content hash and never deletes it', async () => {
    const root = new FakeDir('Cursus')
    const persist = memoryFsPersist()
    const s = new FsStore({ root, persist })
    await root.writeFile('inbox/ipad.cursus', b('export'))
    await root.writeFile('inbox/notes.txt', b('ignored'))
    await root.writeFile('inbox/sub/deep.cursus', b('ignored'))
    const first = await s.inbox()
    expect(first.map((f) => f.key)).toEqual(['inbox/ipad.cursus'])
    expect(first[0]?.bytes).toEqual(b('export'))
    await s.markAbsorbed(first[0]?.hash as string)
    expect(await s.inbox()).toEqual([])
    expect(await s.get({ key: 'inbox/ipad.cursus' })).toEqual(b('export'))
    // Same name, new content: a new file to absorb.
    await root.writeFile('inbox/ipad.cursus', b('export 2'))
    expect((await s.inbox()).map((f) => f.key)).toEqual(['inbox/ipad.cursus'])
  })
})
