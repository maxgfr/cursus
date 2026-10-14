import { expect, test } from 'bun:test'
import { memoryStore } from '../storage/memoryStore'
import { blobRef, blobStore, CHUNK_SIZE, parseManifest } from './blobs'
import { blobKey, bmanKey, sha256Hex } from './codec'

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed + (i >>> 20)) & 0xff)

test('small file: put, get, objectKeys, read', async () => {
  const s = blobStore(memoryStore())
  const data = bytes(1000)
  const id = await s.put(data, 'image/png')
  expect(id).toMatch(/^[0-9a-f]{64}$/)
  expect(blobRef(id)).toBe(`cursus-blob:${id}`)
  const blob = await s.get(id)
  expect(blob?.type).toBe('image/png')
  expect(new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(data)
  const keys = await s.objectKeys(id)
  expect(keys).toEqual([blobKey(sha256Hex(data)), bmanKey(id)])
  expect(await s.read(keys[0] ?? '')).toEqual(data)
  expect(sha256Hex((await s.read(keys[1] ?? '')) ?? new Uint8Array())).toBe(id)
  expect(await s.put(data, 'image/png')).toBe(id)
})

test('large file is split into 4 MiB chunks, chunks listed before the manifest', async () => {
  const s = blobStore(memoryStore())
  const data = bytes(CHUNK_SIZE * 2 + 10)
  const id = await s.put(data, 'application/pdf')
  const m = await s.manifest(id)
  expect(m?.chunks.length).toBe(3)
  expect(m?.size).toBe(data.length)
  const keys = await s.objectKeys(id)
  expect(keys.length).toBe(4)
  expect(keys[3]).toBe(bmanKey(id))
  const back = new Uint8Array((await (await s.get(id))?.arrayBuffer()) ?? new ArrayBuffer(0))
  expect(back.length).toBe(data.length)
  expect(sha256Hex(back)).toBe(sha256Hex(data))
})

test('empty file and unknown ids', async () => {
  const s = blobStore(memoryStore())
  const id = await s.put(new Uint8Array(), 'text/plain')
  expect((await s.get(id))?.size).toBe(0)
  expect(await s.get('0'.repeat(64))).toBeNull()
  expect(await s.objectKeys('0'.repeat(64))).toEqual([])
  expect(await s.read('fmt/v1')).toBeNull()
  expect(await s.read(blobKey('0'.repeat(64)))).toBeNull()
  expect(await s.read(bmanKey('0'.repeat(64)))).toBeNull()
})

test('ingest verifies hashes; a manifest whose chunk is missing yields null until it arrives', async () => {
  const src = blobStore(memoryStore())
  const data = bytes(500, 7)
  const id = await src.put(data, 'audio/mpeg')
  const dst = blobStore(memoryStore())
  const [ck, mk] = await src.objectKeys(id)
  const chunk = (await src.read(ck ?? '')) ?? new Uint8Array()
  const man = (await src.read(mk ?? '')) ?? new Uint8Array()
  await dst.ingest(mk ?? '', man)
  expect(await dst.get(id)).toBeNull()
  await expect(dst.ingest(ck ?? '', chunk.slice(1))).rejects.toThrow(expect.objectContaining({ kind: 'hash' }))
  await dst.ingest(ck ?? '', chunk)
  expect((await dst.get(id))?.type).toBe('audio/mpeg')
  await expect(dst.ingest('seg/a/0000000000-0123456789abcdef.seg', chunk)).rejects.toThrow(RangeError)
  const notManifest = new TextEncoder().encode('{"v":9}')
  await expect(dst.ingest(bmanKey(sha256Hex(notManifest)), notManifest)).rejects.toThrow(
    expect.objectContaining({ kind: 'version' }),
  )
})

test('parseManifest rejects garbage', () => {
  expect(() => parseManifest(new Uint8Array([0xff]))).toThrow(expect.objectContaining({ kind: 'version' }))
  expect(() => parseManifest(new TextEncoder().encode('null'))).toThrow(expect.objectContaining({ kind: 'version' }))
  expect(() => parseManifest(new TextEncoder().encode('{"v":1,"mime":"a","size":1,"chunks":["x"]}'))).toThrow()
  expect(parseManifest(new TextEncoder().encode('{"v":1,"mime":"a","size":0,"chunks":[]}')).mime).toBe('a')
})
