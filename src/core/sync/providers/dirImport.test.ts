import { describe, expect, test } from 'bun:test'
import type { Entry } from '../../contracts/remote'
import { DirImportStore, type ImportedFile } from './dirImport'

const enc = new TextEncoder()
const file = (path: string, body: string, lastModified = 0): ImportedFile => {
  const bytes = enc.encode(body)
  return {
    name: path.split('/').pop() ?? '',
    webkitRelativePath: path,
    size: bytes.length,
    lastModified,
    arrayBuffer: async () => bytes.slice().buffer,
  }
}
async function keys(it: AsyncIterable<Entry>): Promise<string[]> {
  const out: string[] = []
  for await (const e of it) out.push(e.key)
  return out
}

describe('dirImportRemote', () => {
  const files = [
    file('Cursus/seg/d/2.seg', 'two', 20),
    file('Cursus/seg/d/1.seg', 'one', 10),
    file('Cursus/fmt/v1', 'cursus/1\n', 5),
    file('Cursus/.DS_Store', 'junk'),
    file('Cursus/seg/x.crswap', 'swap'),
    file('Cursus/seg//bad', 'empty segment'),
    file('Cursus', 'no key'),
  ]

  test('strips the picked folder name and lists sorted keys, skipping junk', async () => {
    const s = new DirImportStore(files)
    expect(await keys(s.list(''))).toEqual(['fmt/v1', 'seg/d/1.seg', 'seg/d/2.seg'])
    expect(await keys(s.list('seg/'))).toEqual(['seg/d/1.seg', 'seg/d/2.seg'])
    expect(await keys(s.list('seg/', { startAfter: 'seg/d/1.seg' }))).toEqual(['seg/d/2.seg'])
    expect(await keys(s.list('', { createdAfter: 10 }))).toEqual(['seg/d/2.seg'])
    for await (const e of s.list('fmt/')) expect(e.size).toBe(9)
  })

  test('get reads bytes, null when absent', async () => {
    const s = new DirImportStore(files)
    expect(await s.get({ key: 'seg/d/1.seg' })).toEqual(enc.encode('one'))
    expect(await s.get({ key: 'seg/d/3.seg' })).toBeNull()
  })

  test('id depends on the picked folder name', () => {
    expect(new DirImportStore(files).id).toBe(new DirImportStore(files).id)
    expect(new DirImportStore(files).id.startsWith('dir-import-')).toBe(true)
    expect(new DirImportStore([file('Other/fmt/v1', 'x')]).id).not.toBe(new DirImportStore(files).id)
  })

  test('is read-only and maps read failures', async () => {
    const broken: ImportedFile = {
      name: 'k',
      webkitRelativePath: 'Cursus/k',
      size: 1,
      lastModified: 0,
      arrayBuffer: async () => Promise.reject(new DOMException('gone', 'NotReadableError')),
    }
    const s = new DirImportStore([broken])
    await expect(s.put('k')).rejects.toMatchObject({ kind: 'permission' })
    await expect(s.get({ key: 'k' })).rejects.toMatchObject({ kind: 'network' })
  })

  test('skips iCloud conflict copies', async () => {
    const seg = `seg/${'a'.repeat(26)}/0000000001-0123456789abcdef.seg`
    const s = new DirImportStore([file(`Cursus/${seg}`, 'a'), file(`Cursus/${seg.replace('.seg', ' 2.seg')}`, 'b')])
    expect(await keys(s.list(''))).toEqual([seg])
  })

  test('fallback: several picked .cursus files appear under inbox/', async () => {
    const loose = (name: string): ImportedFile => ({ ...file('', name), name })
    const s = new DirImportStore([loose('a.cursus'), loose('b.txt'), loose('.c.cursus')])
    expect(await keys(s.list(''))).toEqual(['inbox/a.cursus'])
    expect(await s.get({ key: 'inbox/a.cursus' })).toEqual(enc.encode('a.cursus'))
    expect(s.id).toBe(new DirImportStore([]).id)
  })
})
