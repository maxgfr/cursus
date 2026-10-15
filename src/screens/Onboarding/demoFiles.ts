/**
 * The demo course's files, made from code on this device: two photos and a slide deck. Byte for byte
 * reproducible (fixed zip timestamps and compression level, no randomness), pure TypeScript (fflate only), so
 * the same course is made offline, in every language, and under `bun test`.
 */
import { zipSync, zlibSync } from 'fflate'

const enc = new TextEncoder()

// --- Pixels ---------------------------------------------------------------------------------------------

type Rgb = readonly [number, number, number]

/** A colour from `#rrggbb`. */
function hex(s: string): Rgb {
  const n = Number.parseInt(s.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function mix(a: Rgb, b: Rgb, k: number): Rgb {
  const w = Math.min(1, Math.max(0, k))
  return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]
}

/** Length of (x, y) (`Math.hypot` is several times slower, and this runs for every pixel). */
const dist = (x: number, y: number): number => Math.sqrt(x * x + y * y)

/** Coverage of a shape whose signed distance (px, negative inside) is `d`: a one-pixel soft edge. */
const cover = (d: number): number => Math.min(1, Math.max(0, 0.5 - d))

/** Signed distance to an ellipse centred on (cx, cy), turned by `angle` (an approximation, good near its edge). */
function ellipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number, angle = 0): number {
  const c = angle === 0 ? 1 : Math.cos(angle)
  const s = angle === 0 ? 0 : Math.sin(angle)
  const dx = (x - cx) * c + (y - cy) * s
  const dy = -(x - cx) * s + (y - cy) * c
  const k = dist(dx / rx, dy / ry)
  return k === 0 ? -Math.min(rx, ry) : (k - 1) * Math.min(rx, ry)
}

/** Distance to the segment (ax, ay)–(bx, by). */
function segment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax
  const vy = by - ay
  const t = Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)))
  return dist(x - ax - vx * t, y - ay - vy * t)
}

/** A small deterministic hash in [0, 1). */
function hash(a: number, b: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * Renders `shade(x, y)` at each pixel centre into RGB rows ready for PNG (filter byte 0 per row). Shapes are
 * anti-aliased by their own soft edge (`cover`), so one sample per pixel is enough.
 */
function render(width: number, height: number, shade: (x: number, y: number) => Rgb): Uint8Array {
  const rows = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 3)
    for (let x = 0; x < width; x++) {
      const c = shade(x + 0.5, y + 0.5)
      rows[o + 1 + x * 3] = Math.round(c[0])
      rows[o + 2 + x * 3] = Math.round(c[1])
      rows[o + 3 + x * 3] = Math.round(c[2])
    }
  }
  return rows
}

// --- PNG ------------------------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length)
  body.set(enc.encode(type))
  body.set(data, 4)
  const out = new Uint8Array(12 + data.length)
  out.set(be32(data.length))
  out.set(body, 4)
  out.set(be32(crc32(body)), 8 + data.length)
  return out
}

function png(width: number, height: number, rows: Uint8Array): Uint8Array {
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', new Uint8Array([...be32(width), ...be32(height), 8, 2, 0, 0, 0])),
    chunk('IDAT', zlibSync(rows, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export interface DemoImage {
  bytes: Uint8Array
  mime: 'image/png'
  width: number
  height: number
}

/** Made once per page: the pictures never change, and a second demo course reuses them. */
function once<T>(make: () => T): () => T {
  let made: { v: T } | null = null
  return () => {
    made ??= { v: make() }
    return made.v
  }
}

function image(width: number, height: number, shade: (x: number, y: number) => Rgb): DemoImage {
  return { bytes: png(width, height, render(width, height, shade)), mime: 'image/png', width, height }
}

/** Onion epidermis under a light microscope: stained cell walls in rows, one nucleus per cell, a round field. */
export const microscopePhoto = once((): DemoImage => {
  const W = 640
  const H = 480
  const dark = hex('#14100f')
  const wall = hex('#8e3f6e')
  const nucleus = hex('#6b2a5a')
  const nucleolus = hex('#3d1233')
  return image(W, H, (x, y) => {
    const r = dist(x - W / 2, y - H / 2)
    const field = 228
    if (r > field + 1) return dark
    const rowH = 62
    const row = Math.floor((y + 10) / rowH)
    const colW = 150
    const wave = 7 * Math.sin((y + row * 40) / 45)
    const shift = row % 2 === 0 ? 0 : colW / 2
    const cx = x + shift + wave
    const col = Math.floor(cx / colW)
    const inX = cx - col * colW
    const inY = y + 10 - row * rowH
    const edge = Math.min(inX, colW - inX, inY, rowH - inY)
    const tint = hash(row, col)
    const cytoplasm = mix(hex('#f6e3ee'), hex('#ecc8dc'), tint)
    let c: Rgb = mix(wall, cytoplasm, (edge - 1.6) / 1.4)
    const nx = 28 + hash(col, row + 7) * (colW - 56)
    const ny = 18 + hash(row + 3, col) * (rowH - 36)
    c = mix(c, nucleus, cover(ellipse(inX, inY, nx, ny, 11, 8.5, tint * 2)))
    c = mix(c, nucleolus, cover(ellipse(inX, inY, nx + 2, ny - 1, 3, 2.6)))
    // Light falls off towards the edge of the field.
    c = mix(c, hex('#3a2a2e'), Math.max(0, (r - field * 0.72) / (field * 0.28)) * 0.55)
    return mix(c, dark, 1 - cover(r - field))
  })
})

/** Ink strokes of the letter A (height 26 px) with its top at (x, y). */
function letterA(px: number, py: number, x: number, y: number): number {
  return Math.min(
    segment(px, py, x, y + 26, x + 9, y),
    segment(px, py, x + 9, y, x + 18, y + 26),
    segment(px, py, x + 4, y + 15, x + 14, y + 15),
  )
}

/** Ink strokes of the letter B (height 26 px) with its top left at (x, y). */
function letterB(px: number, py: number, x: number, y: number): number {
  const bowl = (cy: number, r: number) => {
    const d = Math.abs(dist(px - (x + 9), py - cy) - r)
    return px >= x + 9
      ? d
      : Math.min(segment(px, py, x, cy - r, x + 9, cy - r), segment(px, py, x, cy + r, x + 9, cy + r))
  }
  return Math.min(segment(px, py, x, y, x, y + 26), bowl(y + 6.25, 6.25), bowl(y + 19.5, 6.5))
}

/** An animal cell sketched in a ruled notebook, its nucleus labelled A and a mitochondrion labelled B. */
export const cellSketch = once((): DemoImage => {
  const W = 640
  const H = 480
  const paper = hex('#fbf8ef')
  const rule = hex('#d6e2f0')
  const ink = hex('#22406e')
  const cytoplasm = hex('#eaf1fa')
  const nucleusFill = hex('#c6d4ec')
  const mitoFill = hex('#f2c79a')
  const mitos = [
    [250, 320, 0.5],
    [430, 300, -0.4],
    [210, 200, 1.9],
  ] as const
  return image(W, H, (x, y) => {
    let c: Rgb = paper
    c = mix(c, rule, cover(Math.abs(((y + 16) % 28) - 14) - 13.2))
    const cell = ellipse(x, y, 330, 250, 215, 160, -0.08)
    if (cell < 0) c = mix(c, cytoplasm, cover(cell + 3))
    const nuc = ellipse(x, y, 345, 225, 62, 54)
    c = mix(c, nucleusFill, cover(nuc))
    c = mix(c, ink, cover(ellipse(x, y, 355, 215, 14, 12)))
    let line = Math.min(Math.abs(cell) - 2.2, Math.abs(nuc) - 1.6)
    for (const [mx, my, a] of mitos) {
      // Far from this mitochondrion: nothing of it to draw here.
      if (Math.abs(x - mx) > 36 || Math.abs(y - my) > 36) continue
      const m = ellipse(x, y, mx, my, 30, 14, a)
      c = mix(c, mitoFill, cover(m))
      line = Math.min(line, Math.abs(m) - 1.3)
      // The cristae: a zigzag inside.
      const lx = (x - mx) * Math.cos(a) + (y - my) * Math.sin(a)
      const ly = -(x - mx) * Math.sin(a) + (y - my) * Math.cos(a)
      if (m < -3) line = Math.min(line, Math.abs(ly - 5 * Math.sin(lx / 3.2)) - 0.8)
    }
    // Labels with their leader lines, in the margin.
    const strokes = Math.min(
      letterA(x, y, 560, 70),
      segment(x, y, 556, 92, 398, 196),
      letterB(x, y, 64, 380),
      segment(x, y, 88, 390, 196, 210),
    )
    line = Math.min(line, strokes - 1.4)
    return mix(c, ink, cover(line))
  })
})

/** A phospholipid bilayer crossed by a channel protein: the diagram on the deck's second slide. */
export const bilayerDiagram = once((): DemoImage => {
  const W = 480
  const H = 240
  const head = hex('#3f6fc4')
  const tail = hex('#d99a3a')
  const protein = hex('#5f9e6a')
  const water = hex('#eef5fc')
  return image(W, H, (x, y) => {
    let c: Rgb = water
    const step = 24
    const i = Math.round((x - 12) / step)
    const hx = 12 + i * step
    let tails = Number.POSITIVE_INFINITY
    let heads = Number.POSITIVE_INFINITY
    for (const [top, dir] of [
      [70, 1],
      [170, -1],
    ] as const) {
      heads = Math.min(heads, dist(x - hx, y - top) - 9)
      for (const dx of [-4, 4]) tails = Math.min(tails, segment(x, y, hx + dx, top + dir * 9, hx + dx, top + dir * 42))
    }
    c = mix(c, tail, cover(tails - 1.6))
    c = mix(c, head, cover(heads))
    const p = Math.max(Math.abs(x - 300) - 30, Math.abs(y - 120) - 78)
    c = mix(c, protein, cover(p))
    // The channel through the protein.
    return mix(c, water, cover(Math.max(Math.abs(x - 300) - 7, Math.abs(y - 120) - 80)))
  })
})

// --- Slide deck (.pptx) ---------------------------------------------------------------------------------

/** Local-time components, so the zip's DOS timestamps are the same in every time zone. */
const MTIME = new Date(2020, 0, 1, 0, 0, 0)

function zip(files: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 6; mtime: Date }]> = {}
  for (const [name, body] of Object.entries(files)) {
    entries[name] = [typeof body === 'string' ? enc.encode(body) : body, { level: 6, mtime: MTIME }]
  }
  return zipSync(entries)
}

/** Text as XML character data (the slides are written in the student's language: any character may occur). */
function esc(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const NS_P =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

function rels(list: readonly (readonly [string, string, string])[]): string {
  const items = list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
  return `${XML}<Relationships xmlns="${PKG_REL}">${items.join('')}</Relationships>`
}

function para(text: string): string {
  return `<a:p><a:r><a:rPr/><a:t>${esc(text)}</a:t></a:r></a:p>`
}

function sp(id: number, ph: string, paras: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr><p:ph type="${ph}"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`
  )
}

function pic(id: number, rid: string, descr: string): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${esc(descr)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${rid}"/></p:blipFill><p:spPr/></p:pic>`
  )
}

function table(rows: readonly (readonly string[])[]): string {
  const tr = rows
    .map(
      (r) => `<a:tr h="0">${r.map((c) => `<a:tc><a:txBody><a:bodyPr/>${para(c)}</a:txBody></a:tc>`).join('')}</a:tr>`,
    )
    .join('')
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/>` +
    `</p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl>${tr}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  )
}

function slideXml(shapes: string): string {
  return `${XML}<p:sld ${NS_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`
}

function notesXml(text: string): string {
  return `${XML}<p:notes ${NS_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp(2, 'body', para(text))}</p:spTree></p:cSld></p:notes>`
}

export interface DemoSlide {
  title: string
  /** A subtitle (title slide) or bullets, one per line. */
  subtitle?: string
  bullets?: readonly string[]
  table?: readonly (readonly string[])[]
  image?: { png: Uint8Array; alt: string }
  notes?: string
}

/** A .pptx of these slides, in this order, each with its speaker notes and picture. */
export function deckPptx(title: string, slides: readonly DemoSlide[]): Uint8Array {
  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>`,
    '_rels/.rels': rels([
      ['rId1', 'officeDocument', 'ppt/presentation.xml'],
      ['rId2', 'metadata/core-properties', 'docProps/core.xml'],
    ]),
    'docProps/core.xml':
      `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title></cp:coreProperties>`,
    'ppt/presentation.xml': `${XML}<p:presentation ${NS_P}><p:sldIdLst>${slides
      .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
      .join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels(slides.map((_, i) => [`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`])),
  }
  for (const [i, s] of slides.entries()) {
    const n = i + 1
    const links: [string, string, string][] = []
    let shapes = sp(2, n === 1 ? 'ctrTitle' : 'title', para(s.title))
    if (s.subtitle !== undefined) shapes += sp(3, 'subTitle', para(s.subtitle))
    if (s.bullets !== undefined) shapes += sp(3, 'body', s.bullets.map(para).join(''))
    if (s.table !== undefined) shapes += table(s.table)
    if (s.notes !== undefined) {
      links.push(['rId1', 'notesSlide', `../notesSlides/notesSlide${n}.xml`])
      files[`ppt/notesSlides/notesSlide${n}.xml`] = notesXml(s.notes)
    }
    if (s.image !== undefined) {
      links.push(['rId2', 'image', `../media/image${n}.png`])
      files[`ppt/media/image${n}.png`] = s.image.png
      shapes += pic(4, 'rId2', s.image.alt)
    }
    files[`ppt/slides/slide${n}.xml`] = slideXml(shapes)
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = rels(links)
  }
  return zip(files)
}
