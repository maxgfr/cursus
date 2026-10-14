/** Minimal protobuf reader: just enough for Anki's `MediaEntries` and notetype config. */

export class ProtoError extends Error {
  constructor(m: string) {
    super(m)
    this.name = 'ProtoError'
  }
}

export interface ProtoField {
  no: number
  /** Varint value (wire type 0). */
  int?: number
  /** Length-delimited payload (wire type 2). */
  bytes?: Uint8Array
}

/** Decodes the top-level fields of one protobuf message, in order. */
export function readFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = []
  let pos = 0
  const varint = (): number => {
    let result = 0
    let mul = 1
    for (;;) {
      if (pos >= buf.length) throw new ProtoError('Truncated varint')
      const b = buf[pos++] as number
      result += (b & 0x7f) * mul
      if (b < 0x80) return result
      mul *= 128
      if (mul > 2 ** 63) throw new ProtoError('Varint too long')
    }
  }
  while (pos < buf.length) {
    const tag = varint()
    const no = Math.floor(tag / 8)
    const wire = tag % 8
    if (wire === 0) out.push({ no, int: varint() })
    else if (wire === 2) {
      const len = varint()
      if (pos + len > buf.length) throw new ProtoError('Truncated field')
      out.push({ no, bytes: buf.subarray(pos, pos + len) })
      pos += len
    } else if (wire === 1) pos += 8
    else if (wire === 5) pos += 4
    else throw new ProtoError(`Unsupported wire type ${wire}`)
  }
  if (pos !== buf.length) throw new ProtoError('Truncated fixed field')
  return out
}

export interface MediaEntry {
  name: string
  size: number
}

const dec = new TextDecoder()

/** `MediaEntries { repeated MediaEntry entries = 1; }`, `MediaEntry { string name = 1; uint32 size = 2; bytes sha1 = 3; }`. Zip member `i` holds entry `i`. */
export function decodeMediaEntries(buf: Uint8Array): MediaEntry[] {
  return readFields(buf)
    .filter((f) => f.no === 1 && f.bytes)
    .map((f) => {
      const entry: MediaEntry = { name: '', size: 0 }
      for (const g of readFields(f.bytes as Uint8Array)) {
        if (g.no === 1 && g.bytes) entry.name = dec.decode(g.bytes)
        else if (g.no === 2 && g.int !== undefined) entry.size = g.int
      }
      return entry
    })
}

/** Notetype config: field 1 is `kind` (0 normal, 1 cloze). */
export function notetypeKind(config: Uint8Array): 'normal' | 'cloze' {
  const kind = readFields(config).find((f) => f.no === 1)?.int ?? 0
  return kind === 1 ? 'cloze' : 'normal'
}
