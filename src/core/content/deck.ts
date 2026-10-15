/**
 * Slide decks and structured documents split into citable units: « diapo 12 », « section 2.3 », « p. 7 ».
 *
 * `importDeck` reads a `.pptx`, a `.docx` or a PDF (a slide export becomes a deck, any other PDF a document)
 * and returns its units in order, with their text, speaker notes and images. Nothing is written anywhere: the
 * caller stores the original file and the images as blobs, then creates the source in one workspace batch,
 * so a corrupt, password-protected or oversized file fails with a typed `DeckError` before any write.
 *
 * Hostile files are bounded: the archive's declared sizes are checked before anything is inflated, and the
 * inflated bytes are counted as they come (a lying header cannot exceed its declared size or the global cap);
 * XML document type declarations are refused (no entity expansion, ever); depth, node, unit and image counts
 * are capped. Everything here is pure TypeScript (fflate only): no DOM, testable under `bun test`.
 */
import { Inflate } from 'fflate'
import type { SourceSupport } from '../model/schema'

export type DeckKind = SourceSupport
export type DeckFormat = 'pptx' | 'docx' | 'pdf'
/** What a unit is cited as: « diapo 12 », « p. 7 », « section 2.3 ». */
export type UnitKind = 'slide' | 'page' | 'section'

/** An image of the deck, stored once even when several units show it (a logo on every slide). */
export interface DeckImage {
  /** Stable within the deck: the archive path (`ppt/media/image3.png`). */
  id: string
  mime: string
  bytes: Uint8Array
}

/** An image shown in a unit, by reference to `Deck.images`. */
export interface UnitImageRef {
  id: string
  /** Alternative text written by the author, if any. */
  alt?: string
}

export interface DeckUnit {
  /** 1-based position among the units: the number every citation uses (slide 12, page 7, 12th section). */
  index: number
  kind: UnitKind
  /** The human label: `12` for a slide or a page, `2.3` for a section. */
  label: string
  title: string
  /** Body text as light Markdown (bullets as `- `, tables as Markdown tables), title excluded. */
  text: string
  /** Speaker notes (slides). */
  notes?: string
  images: UnitImageRef[]
  /** Sections: heading level (1 = top) and the titles of the enclosing sections, outermost first. */
  level?: number
  path?: string[]
  /** Slides hidden in the presentation. */
  hidden?: boolean
  /** PDF: the page to render (`renderPdfPage`) when a vision model should see it. */
  page?: number
}

export interface Deck {
  kind: DeckKind
  format: DeckFormat
  title: string
  units: DeckUnit[]
  images: ReadonlyMap<string, DeckImage>
  /** Non-fatal problems, e.g. `image-too-large:ppt/media/image9.png`, `unit-limit`. */
  warnings: string[]
}

export type DeckErrorKind = 'too-large' | 'corrupt' | 'encrypted' | 'unsupported' | 'unsafe'
export class DeckError extends Error {
  constructor(
    readonly kind: DeckErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'DeckError'
  }
}

export interface DeckLimits {
  /** The file itself. */
  maxFileBytes: number
  /** Sum of every inflated archive part. */
  maxUncompressedBytes: number
  /** One inflated XML part. */
  maxPartBytes: number
  /** One image; larger ones are skipped with a warning. */
  maxImageBytes: number
  maxEntries: number
  maxUnits: number
  maxImages: number
  maxXmlDepth: number
  maxXmlNodes: number
  /**
   * Cells of every table of the document once each is padded to its widest row (rows × columns, summed): a few
   * wide rows and many empty ones would otherwise ask for billions of cells from a small file.
   */
  maxTableCells: number
}

export const DEFAULT_DECK_LIMITS: DeckLimits = {
  maxFileBytes: 100 * 1024 * 1024,
  maxUncompressedBytes: 300 * 1024 * 1024,
  maxPartBytes: 32 * 1024 * 1024,
  maxImageBytes: 20 * 1024 * 1024,
  maxEntries: 20_000,
  maxUnits: 2_000,
  maxImages: 1_000,
  maxXmlDepth: 256,
  maxXmlNodes: 2_000_000,
  maxTableCells: 1_000_000,
}

export interface ImportDeckOptions {
  /** File name, used for the default title. */
  name?: string
  limits?: Partial<DeckLimits>
  signal?: AbortSignal
  /** PDF only: how pdf.js is loaded (tests inject one). */
  pdfjs?: () => Promise<typeof import('pdfjs-dist')>
}

export function deckLimits(partial?: Partial<DeckLimits>): DeckLimits {
  return { ...DEFAULT_DECK_LIMITS, ...partial }
}

// ---------------------------------------------------------------------------------------------------------
// Format detection and entry point

const PDF_MAGIC = '%PDF-'
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function startsWithBytes(data: Uint8Array, magic: readonly number[], at = 0): boolean {
  return magic.every((b, i) => data[at + i] === b)
}

function containsUtf16(data: Uint8Array, word: string): boolean {
  const needle = new Uint8Array(word.length * 2)
  for (let i = 0; i < word.length; i++) needle[i * 2] = word.charCodeAt(i)
  outer: for (let i = 0; i + needle.length <= data.length; i++) {
    for (let j = 0; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

/** `pptx`/`docx`/`pdf` from the bytes (never the name alone); typed errors for what cannot be read. */
export function detectDeckFormat(data: Uint8Array, limits: DeckLimits = DEFAULT_DECK_LIMITS): DeckFormat {
  const head = new TextDecoder('latin1').decode(data.subarray(0, 1024))
  if (head.includes(PDF_MAGIC)) return 'pdf'
  if (startsWithBytes(data, OLE_MAGIC)) {
    // Password-protected .pptx/.docx are OLE containers holding an `EncryptedPackage` stream.
    if (containsUtf16(data, 'EncryptedPackage')) throw new DeckError('encrypted', 'the file is password-protected')
    throw new DeckError('unsupported', 'legacy Office file (.ppt/.doc): save it as .pptx or .docx')
  }
  if (startsWithBytes(data, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(data, [0x50, 0x4b, 0x05, 0x06])) {
    const zip = new ZipReader(data, limits)
    if (zip.has('ppt/presentation.xml')) return 'pptx'
    if (zip.has('word/document.xml')) return 'docx'
    throw new DeckError('unsupported', 'archive is neither a PowerPoint nor a Word file')
  }
  throw new DeckError('unsupported', 'not a PDF, PowerPoint or Word file')
}

/** Reads a deck or a document; format modules are loaded on demand. */
export async function importDeck(data: Uint8Array, options: ImportDeckOptions = {}): Promise<Deck> {
  const limits = deckLimits(options.limits)
  if (data.length > limits.maxFileBytes) {
    throw new DeckError('too-large', `file is ${data.length} bytes, limit ${limits.maxFileBytes}`)
  }
  options.signal?.throwIfAborted()
  const format = detectDeckFormat(data, limits)
  if (format === 'pptx') return (await import('./pptx')).readPptx(data, { ...options, limits })
  if (format === 'docx') return (await import('./docx')).readDocx(data, { ...options, limits })
  return (await import('./pdf')).readPdfDeck(data, { ...options, limits })
}

/** Default title from a file name, without its extension. */
export function titleFromName(name: string | undefined): string {
  return (name ?? '').replace(/\.[^.]+$/, '').trim()
}

/** How the source is filed: `kind` stays one older clients know, `support` says how to read it. */
export function sourceFieldsOf(deck: Pick<Deck, 'kind' | 'format'>): { kind: 'pdf' | 'note'; support: DeckKind } {
  return { kind: deck.format === 'pdf' ? 'pdf' : 'note', support: deck.kind }
}

/** The images of a unit, resolved (missing ids are skipped). */
export function unitImages(deck: Pick<Deck, 'images'>, unit: Pick<DeckUnit, 'images'>): DeckImage[] {
  const out: DeckImage[] = []
  for (const ref of unit.images) {
    const img = deck.images.get(ref.id)
    if (img) out.push(img)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Bounded zip reader

interface ZipEntry {
  name: string
  method: number
  flags: number
  compressedSize: number
  size: number
  localOffset: number
}

const u16 = (d: Uint8Array, o: number): number => (d[o] ?? 0) | ((d[o + 1] ?? 0) << 8)
const u32 = (d: Uint8Array, o: number): number => (u16(d, o) | (u16(d, o + 2) << 16)) >>> 0

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const ZIP64 = 0xffffffff
/** Compressed bytes handed to the inflater at a time: bounds what one step can produce (≈ 1032×). */
const INFLATE_STEP = 4096

/**
 * Reads the central directory, then inflates parts on demand with every size bounded. Part names are
 * matched case-insensitively, as OOXML requires.
 */
export class ZipReader {
  private readonly entries = new Map<string, ZipEntry>()
  private inflated = 0

  constructor(
    private readonly data: Uint8Array,
    private readonly limits: DeckLimits,
  ) {
    let eocd = -1
    const floor = Math.max(0, data.length - 22 - 0xffff)
    for (let i = data.length - 22; i >= floor; i--) {
      if (u32(data, i) === EOCD) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new DeckError('corrupt', 'not a readable archive (no central directory)')
    const count = u16(data, eocd + 10)
    const dirOffset = u32(data, eocd + 16)
    if (count === 0xffff || dirOffset === ZIP64) throw new DeckError('unsupported', 'ZIP64 archives are not supported')
    if (count > limits.maxEntries) throw new DeckError('too-large', `archive has ${count} entries`)
    let o = dirOffset
    for (let n = 0; n < count; n++) {
      if (o + 46 > data.length || u32(data, o) !== CENTRAL) throw new DeckError('corrupt', 'damaged archive directory')
      const flags = u16(data, o + 8)
      const method = u16(data, o + 10)
      const compressedSize = u32(data, o + 20)
      const size = u32(data, o + 24)
      const nameLen = u16(data, o + 28)
      const extraLen = u16(data, o + 30)
      const commentLen = u16(data, o + 32)
      const localOffset = u32(data, o + 42)
      if (o + 46 + nameLen > data.length) throw new DeckError('corrupt', 'damaged archive directory')
      const name = new TextDecoder().decode(data.subarray(o + 46, o + 46 + nameLen))
      if (compressedSize === ZIP64 || size === ZIP64 || localOffset === ZIP64) {
        throw new DeckError('unsupported', 'ZIP64 archives are not supported')
      }
      this.entries.set(name.replace(/^\/+/, '').toLowerCase(), {
        name,
        method,
        flags,
        compressedSize,
        size,
        localOffset,
      })
      o += 46 + nameLen + extraLen + commentLen
    }
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase())
  }

  /** Declared (uncompressed) size of a part, or undefined when absent. */
  sizeOf(name: string): number | undefined {
    return this.entries.get(name.toLowerCase())?.size
  }

  /** Inflates a part; null when absent. `cap` bounds this part (default: the XML part limit). */
  read(name: string, cap = this.limits.maxPartBytes): Uint8Array | null {
    const e = this.entries.get(name.toLowerCase())
    if (!e) return null
    if (e.flags & 1) throw new DeckError('encrypted', `${e.name} is encrypted`)
    if (e.size > cap) throw new DeckError('too-large', `${e.name} inflates to ${e.size} bytes, limit ${cap}`)
    if (this.inflated + e.size > this.limits.maxUncompressedBytes) {
      throw new DeckError('too-large', `archive content exceeds ${this.limits.maxUncompressedBytes} bytes`)
    }
    const d = this.data
    const lo = e.localOffset
    if (lo + 30 > d.length || u32(d, lo) !== LOCAL) throw new DeckError('corrupt', `damaged entry ${e.name}`)
    const start = lo + 30 + u16(d, lo + 26) + u16(d, lo + 28)
    const end = start + e.compressedSize
    if (end > d.length) throw new DeckError('corrupt', `truncated entry ${e.name}`)
    const raw = d.subarray(start, end)
    let out: Uint8Array
    if (e.method === 0) {
      if (e.compressedSize !== e.size) throw new DeckError('corrupt', `size mismatch in ${e.name}`)
      out = raw.slice()
    } else if (e.method === 8) {
      out = inflateBounded(raw, e.size, e.name)
    } else {
      throw new DeckError('unsupported', `${e.name} uses compression method ${e.method}`)
    }
    this.inflated += out.length
    return out
  }

  /** A part as UTF-8 text; null when absent. */
  text(name: string): string | null {
    const bytes = this.read(name)
    return bytes === null ? null : new TextDecoder().decode(bytes)
  }
}

/** Inflates at most `expected` bytes: more (a lying header, a bomb) or fewer (truncation) is an error. */
function inflateBounded(raw: Uint8Array, expected: number, name: string): Uint8Array {
  const out = new Uint8Array(expected)
  let total = 0
  let done = false
  const inflater = new Inflate((chunk, final) => {
    if (total + chunk.length > expected) throw new DeckError('too-large', `${name} inflates beyond its declared size`)
    out.set(chunk, total)
    total += chunk.length
    if (final) done = true
  })
  try {
    if (raw.length === 0) inflater.push(raw, true)
    for (let p = 0; p < raw.length; p += INFLATE_STEP) {
      inflater.push(raw.subarray(p, p + INFLATE_STEP), p + INFLATE_STEP >= raw.length)
    }
  } catch (cause) {
    if (cause instanceof DeckError) throw cause
    throw new DeckError('corrupt', `cannot inflate ${name}: ${String(cause)}`)
  }
  if (!done || total !== expected) throw new DeckError('corrupt', `size mismatch in ${name}`)
  return out
}

/** Resolves a relationship target against the folder of the part that declares it. */
export function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = fromPart.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.' && seg !== '') parts.push(seg)
  }
  return parts.join('/')
}

/** `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`. */
export function relsPathOf(part: string): string {
  const i = part.lastIndexOf('/')
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`
}

export interface Relationship {
  type: string
  /** Resolved part name, or the raw target when external. */
  target: string
  external: boolean
}

/** Relationships of a part by id (empty when the part has none). */
export function readRels(zip: ZipReader, part: string, limits: DeckLimits): Map<string, Relationship> {
  const out = new Map<string, Relationship>()
  const xml = zip.text(relsPathOf(part))
  if (xml === null) return out
  for (const rel of descendants(parseXml(xml, limits), 'Relationship')) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (id === undefined || target === undefined) continue
    const external = attr(rel, 'TargetMode') === 'External'
    out.set(id, { type: attr(rel, 'Type') ?? '', target: external ? target : resolvePart(part, target), external })
  }
  return out
}

const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  emf: 'image/emf',
  wmf: 'image/wmf',
}

export function mimeOfPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return IMAGE_MIME[ext] ?? 'application/octet-stream'
}

/** Formats a vision model can be sent as is. */
export function isVisionImage(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp'
}

/** Collects the images of a deck, each part read once, within the image limits. */
export class ImageCollector {
  readonly images = new Map<string, DeckImage>()
  private readonly skipped = new Set<string>()

  constructor(
    private readonly zip: ZipReader,
    private readonly limits: DeckLimits,
    private readonly warnings: string[],
  ) {}

  /** The id to reference, or undefined when the image is missing or skipped. */
  add(path: string): string | undefined {
    if (this.images.has(path)) return path
    if (this.skipped.has(path)) return undefined
    const size = this.zip.sizeOf(path)
    if (size === undefined) return this.skip(path, 'image-missing')
    if (size > this.limits.maxImageBytes) return this.skip(path, 'image-too-large')
    if (this.images.size >= this.limits.maxImages) return this.skip(path, 'image-limit')
    const bytes = this.zip.read(path, this.limits.maxImageBytes)
    if (bytes === null) return this.skip(path, 'image-missing')
    this.images.set(path, { id: path, mime: mimeOfPath(path), bytes })
    return path
  }

  private skip(path: string, why: string): undefined {
    this.skipped.add(path)
    this.warnings.push(`${why}:${path}`)
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------
// Minimal XML reader: elements, attributes, text, CDATA. No DTD, no external or custom entities.

export interface XmlElement {
  name: string
  attrs: Readonly<Record<string, string>>
  children: XmlNode[]
}
export type XmlNode = XmlElement | string

export interface XmlLimits {
  maxXmlDepth: number
  maxXmlNodes: number
}

const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Predefined and numeric character references only; anything else stays literal (never expanded). */
export function decodeXmlText(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(ENTITY, (_m, ref: string) => {
    if (ref.startsWith('#')) {
      const cp = ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10)
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�'
    }
    return NAMED[ref] ?? ''
  })
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d

/** Parses an XML document into a tree; iterative, so depth is bounded by `maxXmlDepth` and not the stack. */
export function parseXml(text: string, limits: XmlLimits = DEFAULT_DECK_LIMITS): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] }
  const stack: XmlElement[] = [root]
  let nodes = 0
  const count = (): void => {
    if (++nodes > limits.maxXmlNodes) throw new DeckError('too-large', 'XML part has too many nodes')
  }
  const top = (): XmlElement => stack[stack.length - 1] ?? root
  const pushText = (t: string): void => {
    if (t === '' || stack.length === 1) return
    count()
    top().children.push(t)
  }
  const corrupt = (why: string): DeckError => new DeckError('corrupt', `malformed XML: ${why}`)
  const len = text.length
  let i = 0
  while (i < len) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      pushText(decodeXmlText(text.slice(i)))
      break
    }
    if (lt > i) pushText(decodeXmlText(text.slice(i, lt)))
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      if (end < 0) throw corrupt('unterminated comment')
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9)
      if (end < 0) throw corrupt('unterminated CDATA')
      pushText(text.slice(lt + 9, end))
      i = end + 3
      continue
    }
    if (text.startsWith('<!', lt)) {
      throw new DeckError('unsafe', 'XML document type declarations are not processed')
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2)
      if (end < 0) throw corrupt('unterminated processing instruction')
      i = end + 2
      continue
    }
    if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt + 2)
      if (end < 0) throw corrupt('unterminated end tag')
      const name = text.slice(lt + 2, end).trim()
      const open = stack.pop()
      if (!open || open === root || open.name !== name) throw corrupt(`unexpected </${name}>`)
      i = end + 1
      continue
    }
    // Start tag.
    let j = lt + 1
    while (j < len && !isSpace(text.charCodeAt(j)) && text[j] !== '>' && text[j] !== '/') j++
    const name = text.slice(lt + 1, j)
    if (name === '') throw corrupt('empty tag name')
    // No prototype: an attribute named `__proto__` is just an attribute.
    const attrs: Record<string, string> = Object.create(null)
    let selfClosing = false
    for (;;) {
      while (j < len && isSpace(text.charCodeAt(j))) j++
      if (j >= len) throw corrupt(`unterminated <${name}>`)
      if (text[j] === '>') {
        j++
        break
      }
      if (text.startsWith('/>', j)) {
        selfClosing = true
        j += 2
        break
      }
      const eq = text.indexOf('=', j)
      if (eq < 0) throw corrupt(`attribute without value in <${name}>`)
      const attrName = text.slice(j, eq).trim()
      let q = eq + 1
      while (q < len && isSpace(text.charCodeAt(q))) q++
      const quote = text[q]
      if (quote !== '"' && quote !== "'") throw corrupt(`unquoted attribute in <${name}>`)
      const close = text.indexOf(quote, q + 1)
      if (close < 0 || attrName === '') throw corrupt(`unterminated attribute in <${name}>`)
      attrs[attrName] = decodeXmlText(text.slice(q + 1, close))
      j = close + 1
    }
    count()
    const el: XmlElement = { name, attrs, children: [] }
    if (stack.length === 1 && root.children.length > 0) throw corrupt('several root elements')
    top().children.push(el)
    if (!selfClosing) {
      if (stack.length > limits.maxXmlDepth) throw new DeckError('too-large', 'XML part is nested too deeply')
      stack.push(el)
    }
    i = j
  }
  if (stack.length > 1) throw corrupt(`unclosed <${top().name}>`)
  const doc = root.children[0]
  if (doc === undefined || typeof doc === 'string') throw corrupt('no root element')
  return doc
}

/** Name without its namespace prefix: `a:t` → `t`. */
export function localName(name: string): string {
  const i = name.indexOf(':')
  return i < 0 ? name : name.slice(i + 1)
}

export function isElement(n: XmlNode | undefined): n is XmlElement {
  return typeof n === 'object'
}

/** Direct child elements with this local name. */
export function childrenOf(el: XmlElement, local: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => isElement(c) && localName(c.name) === local)
}

export function childOf(el: XmlElement | undefined, local: string): XmlElement | undefined {
  if (!el) return undefined
  for (const c of el.children) if (isElement(c) && localName(c.name) === local) return c
  return undefined
}

/** Descendant elements with this local name, in document order (iterative). */
export function descendants(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = []
  const stack: XmlElement[] = [el]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur) break
    for (let k = cur.children.length - 1; k >= 0; k--) {
      const c = cur.children[k]
      if (isElement(c)) stack.push(c)
    }
    if (cur !== el && localName(cur.name) === local) out.push(cur)
  }
  return out
}

/** Attribute by exact name, else by local name (`val` finds `w:val`, `embed` finds `r:embed`). */
export function attr(el: XmlElement | undefined, name: string): string | undefined {
  if (!el) return undefined
  const exact = el.attrs[name]
  if (exact !== undefined) return exact
  for (const [k, v] of Object.entries(el.attrs)) if (k.includes(':') && localName(k) === name) return v
  return undefined
}

/** Namespaced attribute only (`r:id`, never a plain `id`). */
export function nsAttr(el: XmlElement | undefined, local: string): string | undefined {
  if (!el) return undefined
  for (const [k, v] of Object.entries(el.attrs)) if (k.includes(':') && localName(k) === local) return v
  return undefined
}

// ---------------------------------------------------------------------------------------------------------
// Text helpers shared by the formats

/** Collapses runs of spaces, trims lines, and keeps at most one blank line in a row. */
export function tidyText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => {
      // Leading indentation is structure (nested bullets): keep it, collapse the rest.
      const indent = /^ */.exec(l)?.[0] ?? ''
      return (
        indent +
        l
          .slice(indent.length)
          .replace(/[ \t\u00a0]+/g, ' ')
          .trimEnd()
      )
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const cell = (s: string): string =>
  s
    .replace(/\s*\n\s*/g, ' <br> ')
    .replaceAll('|', '\\|')
    .trim()

/** What is left of a document's table cells (`maxTableCells`), shared by every table it holds. */
export class TableBudget {
  private left: number

  constructor(readonly limit: number) {
    this.left = limit
  }

  /** Spends `cells`; past the limit the document is refused (`too-large`), before anything is built. */
  take(cells: number): void {
    this.check(cells)
    this.left -= cells
  }

  /** Throws when `cells` (a row still being read, say) would already pass what is left. */
  check(cells: number): void {
    if (cells > this.left) throw new DeckError('too-large', `the tables hold more than ${this.limit} cells`)
  }
}

/**
 * Rows of cells as a Markdown table, the first row as header; ragged rows are padded. The padded size is taken
 * from `budget` first (one per document; a fresh default one when none is given).
 */
export function tableToMarkdown(
  rows: readonly (readonly string[])[],
  budget = new TableBudget(DEFAULT_DECK_LIMITS.maxTableCells),
): string {
  // A loop, not `Math.max(...)`: spreading a huge array throws (Safari, past ~65K arguments).
  let width = 0
  for (const r of rows) if (r.length > width) width = r.length
  if (rows.length === 0 || width === 0) return ''
  budget.take(width * rows.length)
  const line = (r: readonly string[]): string =>
    `| ${Array.from({ length: width }, (_, k) => cell(r[k] ?? '')).join(' | ')} |`
  const [head, ...body] = rows
  return [line(head ?? []), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n')
}
