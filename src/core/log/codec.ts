import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { unzlibSync, zlibSync } from 'fflate'
import * as Y from 'yjs'
import { EnvelopeError } from '../contracts/errors'
import type { EnvelopeCodec, Header, ParsedKey } from '../contracts/log'
import type { Key } from '../contracts/remote'

/** Envelope: MAGIC(4) | version(1) | zlib( u32be headerLen | header JSON | Yjs update V2 ). */
export const MAGIC = new Uint8Array([0x43, 0x52, 0x53, 0x59]) // "CRSY"
export const FORMAT_VERSION = 1
export const BLOB_PREFIX = 'cursus-blob:'

const DEVICE = '[A-Za-z0-9_-]{1,64}'
const KEY_PATTERNS: [RegExp, (m: RegExpMatchArray) => ParsedKey | null][] = [
  [/^fmt\/v1$/, () => ({ kind: 'fmt' })],
  [/^ws\/([A-Za-z0-9_-]{1,64})$/, (m) => ({ kind: 'ws', workspaceId: m[1] ?? '' })],
  [/^keys\/([0-9a-f]{64})\.json$/, (m) => ({ kind: 'keys', hash: m[1] ?? '' })],
  [
    new RegExp(`^seg/(${DEVICE})/([0-9]{10})-([0-9a-f]{16})\\.seg$`),
    (m) => ({ kind: 'seg', deviceId: m[1] ?? '', seq: Number(m[2]), h16: m[3] ?? '' }),
  ],
  [
    new RegExp(`^ckpt/(${DEVICE})/([0-9a-f]{16})\\.ckpt$`),
    (m) => ({ kind: 'ckpt', deviceId: m[1] ?? '', h16: m[2] ?? '' }),
  ],
  [
    /^blob\/([0-9a-f]{2})\/([0-9a-f]{64})$/,
    (m) => (m[2]?.startsWith(m[1] ?? '-') ? { kind: 'blob', h64: m[2] } : null),
  ],
  [/^bman\/([0-9a-f]{64})$/, (m) => ({ kind: 'bman', h64: m[1] ?? '' })],
]

/** Strict: anything a sync client may have mangled ("x 2.seg", uppercase hex, extra dirs) is null. */
export function parseKey(name: string): ParsedKey | null {
  for (const [re, build] of KEY_PATTERNS) {
    const m = name.match(re)
    if (m) return build(m)
  }
  return null
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

export const blobKey = (h64: string): Key => `blob/${h64.slice(0, 2)}/${h64}`
export const bmanKey = (h64: string): Key => `bman/${h64}`

export function keyFor(h: Header, bytes: Uint8Array): Key {
  const h16 = sha256Hex(bytes).slice(0, 16)
  if (!new RegExp(`^${DEVICE}$`).test(h.deviceId)) throw new RangeError(`Invalid deviceId ${h.deviceId}`)
  if (h.kind === 'ckpt') return `ckpt/${h.deviceId}/${h16}.ckpt`
  if (!Number.isInteger(h.seq) || h.seq < 0 || h.seq >= 1e10) throw new RangeError(`Invalid seq ${h.seq}`)
  return `seg/${h.deviceId}/${String(h.seq).padStart(10, '0')}-${h16}.seg`
}

/** Deterministic JSON: fixed field order, optional covers only when present. */
function headerJson(h: Header): string {
  const o: Header = {
    v: h.v,
    kind: h.kind,
    deviceId: h.deviceId,
    seq: h.seq,
    createdAt: h.createdAt,
    blobRefs: [...h.blobRefs],
  }
  if (h.covers) o.covers = [...h.covers]
  return JSON.stringify(o)
}

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

function collectRefs(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/cursus-blob:([0-9a-f]{64})/g)) if (m[1]) out.add(m[1])
  } else if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out)
  } else if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    for (const v of Object.values(value)) collectRefs(v, out)
  }
}

/** Blob ids (h64 of the manifest) referenced as `cursus-blob:<h64>` strings anywhere in the update. */
export function refsOf(update: Uint8Array): string[] {
  const out = new Set<string>()
  for (const s of Y.decodeUpdateV2(update).structs) {
    if (!(s instanceof Y.Item)) continue
    const c = s.content
    if (c instanceof Y.ContentString) collectRefs(c.str, out)
    else if (c instanceof Y.ContentAny) collectRefs(c.arr, out)
    else if (c instanceof Y.ContentEmbed) collectRefs(c.embed, out)
    else if (c instanceof Y.ContentFormat) collectRefs(c.value, out)
    else if (c instanceof Y.ContentJSON) collectRefs(c.arr, out)
  }
  return [...out].sort()
}

export function encode(h: Header, update: Uint8Array): { key: Key; bytes: Uint8Array } {
  const hj = enc.encode(headerJson(h))
  const inner = new Uint8Array(4 + hj.length + update.length)
  new DataView(inner.buffer).setUint32(0, hj.length)
  inner.set(hj, 4)
  inner.set(update, 4 + hj.length)
  const z = zlibSync(inner, { level: 6 })
  const bytes = new Uint8Array(MAGIC.length + 1 + z.length)
  bytes.set(MAGIC, 0)
  bytes[MAGIC.length] = FORMAT_VERSION
  bytes.set(z, MAGIC.length + 1)
  return { key: keyFor(h, bytes), bytes }
}

function isHeader(x: unknown): x is Header {
  if (x === null || typeof x !== 'object') return false
  const h = x as Record<string, unknown>
  return (
    h.v === 1 &&
    (h.kind === 'seg' || h.kind === 'ckpt') &&
    typeof h.deviceId === 'string' &&
    typeof h.seq === 'number' &&
    typeof h.createdAt === 'number' &&
    Array.isArray(h.blobRefs) &&
    h.blobRefs.every((r) => typeof r === 'string') &&
    (h.covers === undefined || (Array.isArray(h.covers) && h.covers.every((c) => typeof c === 'string')))
  )
}

/** Verifies hash (vs key) ⇒ magic ⇒ version, then that the header agrees with the key. Never re-encodes. */
export function decode(key: Key, bytes: Uint8Array): { header: Header; update: Uint8Array } {
  const parsed = parseKey(key)
  if (!parsed || (parsed.kind !== 'seg' && parsed.kind !== 'ckpt')) throw new RangeError(`Not a segment key: ${key}`)
  if (sha256Hex(bytes).slice(0, 16) !== parsed.h16) throw new EnvelopeError('hash', `Hash mismatch for ${key}`)
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new EnvelopeError('magic', `Bad magic for ${key}`)
  }
  if (bytes[MAGIC.length] !== FORMAT_VERSION) throw new EnvelopeError('version', `Unknown format for ${key}`)
  let header: unknown
  let update: Uint8Array
  try {
    const inner = unzlibSync(bytes.subarray(MAGIC.length + 1))
    const len = new DataView(inner.buffer, inner.byteOffset, inner.byteLength).getUint32(0)
    header = JSON.parse(dec.decode(inner.subarray(4, 4 + len)))
    update = inner.slice(4 + len)
  } catch (e) {
    throw new EnvelopeError('version', `Undecodable envelope ${key}: ${String(e)}`)
  }
  if (!isHeader(header)) throw new EnvelopeError('version', `Unknown header for ${key}`)
  const agrees =
    header.kind === parsed.kind &&
    header.deviceId === parsed.deviceId &&
    (parsed.kind === 'ckpt' || header.seq === parsed.seq)
  if (!agrees) throw new EnvelopeError('hash', `Header does not match ${key}`)
  return { header, update }
}

export const codec: EnvelopeCodec = { encode, decode, parseKey }
