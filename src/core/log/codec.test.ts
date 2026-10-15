import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import { zlibSync } from 'fflate'
import * as Y from 'yjs'
import { codec as v1Codec } from '../../../tests/fixtures/v1-reader/codec'
import { EnvelopeError } from '../contracts/errors'
import type { Header } from '../contracts/log'
import {
  blobKey,
  bmanKey,
  codec,
  decode,
  decodeAsync,
  encode,
  FORMAT_VERSION,
  keyFor,
  MAGIC,
  parseKey,
  refsOf,
  sha256Hex,
} from './codec'

const H64 = 'ab'.repeat(32)
const FIX = `${import.meta.dir}/../../../tests/fixtures/v1/`
const SEG_KEY = 'seg/fixturedev/0000000000-64ab7664d527cb46.seg'
const CKPT_KEY = 'ckpt/fixturedev/ebbbb1beb296bed1.ckpt'

function updateOf(fn: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = 7
  fn(doc)
  return Y.encodeStateAsUpdateV2(doc)
}

const header = (o: Partial<Header> = {}): Header => ({
  v: 1,
  kind: 'seg',
  deviceId: 'dev1',
  seq: 3,
  createdAt: 1000,
  blobRefs: [],
  ...o,
})

/** Builds raw bytes and the key that matches their hash, to test checks after the hash. */
function withKey(kind: 'seg' | 'ckpt', bytes: Uint8Array, deviceId = 'dev1', seq = 3): string {
  return keyFor(header({ kind, deviceId, seq }), bytes)
}

describe('parseKey', () => {
  test('accepts every remote key shape', () => {
    expect(parseKey('fmt/v1')).toEqual({ kind: 'fmt' })
    expect(parseKey('ws/01ABC')).toEqual({ kind: 'ws', workspaceId: '01ABC' })
    expect(parseKey(`keys/${H64}.json`)).toEqual({ kind: 'keys', hash: H64 })
    expect(parseKey('seg/dev-1/0000000042-0123456789abcdef.seg')).toEqual({
      kind: 'seg',
      deviceId: 'dev-1',
      seq: 42,
      h16: '0123456789abcdef',
    })
    expect(parseKey('ckpt/dev_1/0123456789abcdef.ckpt')).toEqual({
      kind: 'ckpt',
      deviceId: 'dev_1',
      h16: '0123456789abcdef',
    })
    expect(parseKey(`blob/ab/${H64}`)).toEqual({ kind: 'blob', h64: H64 })
    expect(parseKey(`bman/${H64}`)).toEqual({ kind: 'bman', h64: H64 })
  })
  test('is strict about mangled names', () => {
    for (const bad of [
      'x 2.seg',
      'seg/dev1/0000000042-0123456789abcdef 2.seg',
      'seg/dev1/42-0123456789abcdef.seg',
      'seg/dev1/0000000042-0123456789ABCDEF.seg',
      'seg/de v/0000000042-0123456789abcdef.seg',
      'seg/a/b/0000000042-0123456789abcdef.seg',
      'fmt/v3',
      '/fmt/v1',
      `blob/cd/${H64}`,
      `bman/${H64}x`,
      `keys/${H64}.JSON`,
      'ckpt/dev1/0123456789abcdef.ckpt.tmp',
      '',
    ])
      expect(parseKey(bad)).toBeNull()
  })
  test('blob and manifest key helpers round-trip', () => {
    expect(parseKey(blobKey(H64))).toEqual({ kind: 'blob', h64: H64 })
    expect(parseKey(bmanKey(H64))).toEqual({ kind: 'bman', h64: H64 })
  })
})

describe('encode / decode', () => {
  test('round-trips header and update, key names the hash of the bytes', () => {
    const u = updateOf((d) => d.getMap('m').set('a', 1))
    const h = header()
    const { key, bytes } = encode(h, u)
    expect(key).toBe(`seg/dev1/0000000003-${sha256Hex(bytes).slice(0, 16)}.seg`)
    expect([...bytes.subarray(0, 4)]).toEqual([...MAGIC])
    const out = decode(key, bytes)
    expect(out.header).toEqual(h)
    expect(out.update).toEqual(u)
    expect(codec.decode(key, bytes).update).toEqual(u)
  })
  test('is deterministic, whatever the header field order', () => {
    const u = updateOf((d) => d.getText('t').insert(0, 'hello'))
    const a = encode(header({ covers: ['x'] }), u)
    const b = encode({ covers: ['x'], blobRefs: [], createdAt: 1000, seq: 3, deviceId: 'dev1', kind: 'seg', v: 1 }, u)
    expect(b.bytes).toEqual(a.bytes)
    expect(b.key).toBe(a.key)
  })
  test('checkpoint keys have no seq', () => {
    const { key, bytes } = encode(
      header({ kind: 'ckpt', covers: ['seg/a/0000000000-0123456789abcdef.seg'] }),
      new Uint8Array(),
    )
    expect(key).toMatch(/^ckpt\/dev1\/[0-9a-f]{16}\.ckpt$/)
    expect(decode(key, bytes).header.covers).toEqual(['seg/a/0000000000-0123456789abcdef.seg'])
  })
  test('rejects invalid deviceId and seq at encode time', () => {
    expect(() => encode(header({ deviceId: 'a b' }), new Uint8Array())).toThrow(RangeError)
    expect(() => encode(header({ seq: -1 }), new Uint8Array())).toThrow(RangeError)
    expect(() => encode(header({ seq: 1e10 }), new Uint8Array())).toThrow(RangeError)
  })
  test('hash mismatch ⇒ EnvelopeError hash', () => {
    const { key, bytes } = encode(header(), new Uint8Array([0]))
    const bad = bytes.slice()
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1
    expect(() => decode(key, bad)).toThrow(expect.objectContaining({ kind: 'hash' }))
  })
  test('bad magic ⇒ EnvelopeError magic', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 1, 0])
    expect(() => decode(withKey('seg', bytes), bytes)).toThrow(expect.objectContaining({ kind: 'magic' }))
  })
  test('unknown version, undecodable body or header ⇒ EnvelopeError version', () => {
    const v3 = new Uint8Array([...MAGIC, 3, 0])
    expect(() => decode(withKey('seg', v3), v3)).toThrow(expect.objectContaining({ kind: 'version' }))
    const junk = new Uint8Array([...MAGIC, 1, 9, 9, 9])
    expect(() => decode(withKey('seg', junk), junk)).toThrow(expect.objectContaining({ kind: 'version' }))
    const hj = new TextEncoder().encode('{"v":2}')
    const inner = new Uint8Array(4 + hj.length)
    new DataView(inner.buffer).setUint32(0, hj.length)
    inner.set(hj, 4)
    const odd = new Uint8Array([...MAGIC, 1, ...zlibSync(inner)])
    expect(() => decode(withKey('seg', odd), odd)).toThrow(expect.objectContaining({ kind: 'version' }))
  })
  test('header that disagrees with its key ⇒ EnvelopeError hash', () => {
    const { bytes } = encode(header(), new Uint8Array())
    expect(() => decode(withKey('seg', bytes, 'other'), bytes)).toThrow(EnvelopeError)
    expect(() => decode(withKey('seg', bytes, 'dev1', 4), bytes)).toThrow(expect.objectContaining({ kind: 'hash' }))
    expect(() => decode(withKey('ckpt', bytes), bytes)).toThrow(expect.objectContaining({ kind: 'hash' }))
  })
  test('non-log keys are refused', () => {
    expect(() => decode('fmt/v1', new Uint8Array())).toThrow(RangeError)
    expect(() => decode('nope', new Uint8Array())).toThrow(RangeError)
  })
  test('property: any header and update round-trip exactly', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
        fc.integer({ min: 0, max: 9_999_999_999 }),
        fc.integer({ min: 0 }),
        fc.uint8Array({ maxLength: 512 }),
        fc.array(fc.stringMatching(/^[0-9a-f]{64}$/), { maxLength: 3 }),
        (deviceId, seq, createdAt, update, blobRefs) => {
          const h = header({ deviceId, seq, createdAt, blobRefs })
          const { key, bytes } = encode(h, update)
          const out = decode(key, bytes)
          expect(out.header).toEqual(h)
          expect(out.update).toEqual(update)
          expect(parseKey(key)).toMatchObject({ kind: 'seg', deviceId, seq })
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('decodeAsync (platform zlib)', () => {
  test('decodes exactly what decode does, any header and update', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
        fc.integer({ min: 0, max: 9_999_999_999 }),
        fc.uint8Array({ maxLength: 4096 }),
        async (deviceId, seq, update) => {
          const { key, bytes } = encode(header({ deviceId, seq }), update)
          expect(await decodeAsync(key, bytes)).toEqual(decode(key, bytes))
        },
      ),
      { numRuns: 50 },
    )
    expect(codec.decodeAsync).toBe(decodeAsync)
  })
  test('a large update (megabytes) comes back byte for byte', async () => {
    const u = updateOf((d) => {
      const m = d.getMap('m')
      for (let i = 0; i < 20_000; i++) m.set(`k${i}`, { i, text: `review ${i} of a long history` })
    })
    const { key, bytes } = encode(header(), u)
    expect((await decodeAsync(key, bytes)).update).toEqual(u)
  })
  test('the same errors as decode: hash, magic, version, a key that is not a segment', async () => {
    const { key, bytes } = encode(header(), new Uint8Array([0]))
    const bad = bytes.slice()
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1
    await expect(decodeAsync(key, bad)).rejects.toMatchObject({ kind: 'hash' })
    const magic = new Uint8Array([1, 2, 3, 4, 1, 0])
    await expect(decodeAsync(withKey('seg', magic), magic)).rejects.toMatchObject({ kind: 'magic' })
    const junk = new Uint8Array([...MAGIC, 1, 9, 9, 9])
    await expect(decodeAsync(withKey('seg', junk), junk)).rejects.toMatchObject({ kind: 'version' })
    const other = encode(header(), new Uint8Array()).bytes
    await expect(decodeAsync(withKey('seg', other, 'dev1', 4), other)).rejects.toMatchObject({ kind: 'hash' })
    await expect(decodeAsync('fmt/v1', new Uint8Array())).rejects.toThrow(RangeError)
  })
  test('without a platform zlib or SHA-256, falls back to the bundled ones', async () => {
    const native = globalThis.DecompressionStream
    const subtle = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(crypto), 'subtle')
    const { key, bytes } = encode(
      header(),
      updateOf((d) => d.getText('t').insert(0, 'fallback')),
    )
    const bad = bytes.slice()
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1
    try {
      Reflect.deleteProperty(globalThis, 'DecompressionStream')
      Object.defineProperty(crypto, 'subtle', { configurable: true, value: undefined })
      expect(await decodeAsync(key, bytes)).toEqual(decode(key, bytes))
      await expect(decodeAsync(key, bad)).rejects.toMatchObject({ kind: 'hash' })
    } finally {
      globalThis.DecompressionStream = native
      Reflect.deleteProperty(crypto, 'subtle')
      if (subtle && crypto.subtle === undefined) Object.defineProperty(crypto, 'subtle', subtle)
    }
    expect(crypto.subtle).toBeDefined()
  })
})

describe('refsOf', () => {
  test('finds cursus-blob refs in map values, text, embeds, formats and arrays', () => {
    const ids = ['1', '2', '3', '4', '5'].map((c) => c.repeat(64))
    const u = updateOf((d) => {
      d.getMap('m').set('src', `cursus-blob:${ids[0]}`)
      d.getMap('m').set('nested', { list: [`x cursus-blob:${ids[1]} y`], n: 1, b: new Uint8Array([1]) })
      const t = d.getText('t')
      t.insert(0, `see cursus-blob:${ids[2]}`)
      t.insertEmbed(0, { img: `cursus-blob:${ids[3]}` })
      t.format(0, 2, { link: `cursus-blob:${ids[4]}` })
      d.getArray('a').push([null, 'cursus-blob:nothex'])
    })
    expect(refsOf(u)).toEqual([...ids].sort())
  })
  test('no refs in an empty update', () => {
    expect(refsOf(Y.encodeStateAsUpdateV2(new Y.Doc()))).toEqual([])
  })
})

describe('v1 fixtures (never regenerated)', () => {
  test('segment.bin decodes to the documented content', async () => {
    const bytes = new Uint8Array(await Bun.file(`${FIX}segment.bin`).arrayBuffer())
    const { header: h, update } = decode(SEG_KEY, bytes)
    expect(h).toEqual({ v: 1, kind: 'seg', deviceId: 'fixturedev', seq: 0, createdAt: 1700000000000, blobRefs: [H64] })
    const doc = new Y.Doc()
    Y.applyUpdateV2(doc, update)
    expect(doc.getMap('courses').toJSON()).toEqual({
      'course-1': { id: 'course-1', title: 'Fixture course', cover: `cursus-blob:${H64}` },
    })
    expect(refsOf(update)).toEqual([H64])
    // Version 1 is still exactly what this codec lays out when asked for it (it now writes version 2).
    expect(encode(h, update, 1).bytes).toEqual(bytes)
  })
  test('checkpoint.bin decodes with covers and the same state', async () => {
    const bytes = new Uint8Array(await Bun.file(`${FIX}checkpoint.bin`).arrayBuffer())
    const { header: h, update } = decode(CKPT_KEY, bytes)
    expect(h.kind).toBe('ckpt')
    expect(h.covers).toEqual([SEG_KEY])
    const doc = new Y.Doc()
    Y.applyUpdateV2(doc, update)
    expect(doc.getMap('courses').get('course-1')).toBeInstanceOf(Y.Map)
    expect((doc.getMap('courses').get('course-1') as Y.Map<string>).get('title')).toBe('Fixture course')
  })
})

const FIX2 = `${import.meta.dir}/../../../tests/fixtures/v2/`
const SEG2_KEY = 'seg/fixturedev/0000000000-cf7595873c8df2e1.seg'
const CKPT2_KEY = 'ckpt/fixturedev/935eb772d0667f61.ckpt'

describe('v2 fixtures (never regenerated)', () => {
  test('segment.bin decodes to the documented content, the compact review log included', async () => {
    const bytes = new Uint8Array(await Bun.file(`${FIX2}segment.bin`).arrayBuffer())
    expect(bytes[MAGIC.length]).toBe(2)
    const { header: h, update } = decode(SEG2_KEY, bytes)
    expect(h).toEqual({ v: 1, kind: 'seg', deviceId: 'fixturedev', seq: 0, createdAt: 1700000000000, blobRefs: [H64] })
    const doc = new Y.Doc()
    Y.applyUpdateV2(doc, update)
    expect(doc.getMap('courses').toJSON()).toEqual({
      'course-1': { id: 'course-1', title: 'Fixture course', cover: `cursus-blob:${H64}` },
    })
    expect(doc.getArray('reviewLog').toJSON()).toEqual(['[1,"review-1","card-1",3,1700000000000,4000,"fixturedev"]'])
    expect(refsOf(update)).toEqual([H64])
    expect(encode(h, update).bytes).toEqual(bytes)
    expect(await decodeAsync(SEG2_KEY, bytes)).toEqual(decode(SEG2_KEY, bytes))
  })
  test('checkpoint.bin decodes with covers and the same state', async () => {
    const bytes = new Uint8Array(await Bun.file(`${FIX2}checkpoint.bin`).arrayBuffer())
    const { header: h, update } = decode(CKPT2_KEY, bytes)
    expect(h).toMatchObject({ kind: 'ckpt', covers: [SEG2_KEY], blobRefs: [H64] })
    const doc = new Y.Doc()
    Y.applyUpdateV2(doc, update)
    expect((doc.getMap('courses').get('course-1') as Y.Map<string>).get('title')).toBe('Fixture course')
    expect(doc.getArray('reviewLog').length).toBe(1)
  })
})

describe('format gate: an earlier build never applies what this one writes', () => {
  test('this build writes version 2 and reads versions 1 and 2', async () => {
    expect(FORMAT_VERSION).toBe(2)
    const u = updateOf((d) => d.getArray('reviewLog').push(['[2,"v","r"]']))
    const { key, bytes } = encode(header(), u)
    expect(bytes[MAGIC.length]).toBe(2)
    expect(decode(key, bytes).update).toEqual(u)
    const old = encode(header(), u, 1)
    expect(old.bytes[MAGIC.length]).toBe(1)
    expect(decode(old.key, old.bytes).update).toEqual(u)
    expect((await decodeAsync(old.key, old.bytes)).update).toEqual(u)
  })
  test('the last version-1 codec refuses every object this build writes, as a version (needs-upgrade) error', async () => {
    const segment = encode(
      header(),
      updateOf((d) => d.getMap('m').set('a', 1)),
    )
    const checkpoint = encode(header({ kind: 'ckpt', covers: [segment.key] }), new Uint8Array())
    const fixture = new Uint8Array(await Bun.file(`${FIX2}segment.bin`).arrayBuffer())
    for (const [key, bytes] of [
      [segment.key, segment.bytes],
      [checkpoint.key, checkpoint.bytes],
      [SEG2_KEY, fixture],
    ] as const)
      expect(() => v1Codec.decode(key, bytes)).toThrow(expect.objectContaining({ kind: 'version' }))
    expect(() => v1Codec.decode(segment.key, segment.bytes)).toThrow(EnvelopeError)
    // What it wrote itself, it still reads, as this build does.
    const v1 = new Uint8Array(await Bun.file(`${FIX}segment.bin`).arrayBuffer())
    expect(v1Codec.decode(SEG_KEY, v1)).toEqual(decode(SEG_KEY, v1))
  })
})
