/**
 * Word `.docx`: headings become hierarchical sections (« section 2.3 »), paragraphs and lists their text,
 * tables Markdown tables, pictures their images. Long sections are split at paragraph boundaries so every
 * unit fits a model's context. Pure: fflate and the small XML reader of `deck.ts`, no DOM.
 */
import {
  attr,
  childOf,
  childrenOf,
  type Deck,
  DeckError,
  type DeckLimits,
  type DeckUnit,
  descendants,
  ImageCollector,
  isElement,
  localName,
  nsAttr,
  parseXml,
  type Relationship,
  readRels,
  TableBudget,
  tableToMarkdown,
  tidyText,
  titleFromName,
  type UnitImageRef,
  type XmlElement,
  ZipReader,
} from './deck'
import { coreTitle, mainPart, type ReadOfficeOptions } from './pptx'

/** A section longer than this is split into parts (« 2.3 (2) »). */
export const MAX_SECTION_CHARS = 12_000

const REL_IMAGE = '/image'
const REL_STYLES = '/styles'
const MAX_BASED_ON = 20

interface StyleInfo {
  /** 1-based heading level. */
  heading?: number
  title?: boolean
  list?: boolean
}

interface RawStyle {
  basedOn?: string
  outline?: number
  name: string
  list: boolean
}

function outlineLevel(pPr: XmlElement | undefined): number | undefined {
  const v = attr(childOf(pPr, 'outlineLvl'), 'val')
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n < 9 ? n + 1 : undefined
}

/** Heading levels by style id, following `basedOn` (bounded, cycles ignored). */
function readStyles(zip: ZipReader, part: string, limits: DeckLimits): Map<string, StyleInfo> {
  const raw = new Map<string, RawStyle>()
  const xml = zip.text(part)
  if (xml !== null) {
    for (const s of descendants(parseXml(xml, limits), 'style')) {
      const id = attr(s, 'styleId')
      if (id === undefined) continue
      const pPr = childOf(s, 'pPr')
      raw.set(id, {
        basedOn: attr(childOf(s, 'basedOn'), 'val'),
        outline: outlineLevel(pPr),
        name: (attr(childOf(s, 'name'), 'val') ?? '').toLowerCase(),
        list: childOf(pPr, 'numPr') !== undefined,
      })
    }
  }
  const out = new Map<string, StyleInfo>()
  for (const id of raw.keys()) {
    const info: StyleInfo = {}
    let cur: string | undefined = id
    for (let hop = 0; cur !== undefined && hop < MAX_BASED_ON; hop++) {
      const s = raw.get(cur)
      if (!s) break
      const named = /^heading ([1-9])$/.exec(s.name)
      if (info.heading === undefined) info.heading = s.outline ?? (named ? Number(named[1]) : undefined)
      if (s.name === 'title') info.title = true
      if (s.list) info.list = true
      cur = s.basedOn
    }
    out.set(id, info)
  }
  return out
}

/** Elements whose subtree never contributes text: properties, deletions, field codes, drawings. */
const SKIP = new Set(['pPr', 'rPr', 'del', 'moveFrom', 'instrText', 'fldChar', 'drawing', 'pict', 'object', 'tabs'])

function runText(p: XmlElement): string {
  let out = ''
  const stack: XmlElement[] = [p]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur) break
    const n = localName(cur.name)
    if (cur !== p) {
      if (SKIP.has(n)) continue
      if (n === 't') {
        for (const c of cur.children) if (typeof c === 'string') out += c
        continue
      }
      if (n === 'tab') out += '\t'
      else if (n === 'br' || n === 'cr') out += '\n'
      else if (n === 'noBreakHyphen') out += '-'
      if (n === 'AlternateContent') {
        const choice = childOf(cur, 'Choice') ?? childOf(cur, 'Fallback')
        if (choice) stack.push(choice)
        continue
      }
    }
    for (let k = cur.children.length - 1; k >= 0; k--) {
      const c = cur.children[k]
      if (isElement(c)) stack.push(c)
    }
  }
  return out
}

function paragraphImages(
  p: XmlElement,
  rels: ReadonlyMap<string, Relationship>,
  images: ImageCollector,
): UnitImageRef[] {
  const out: UnitImageRef[] = []
  const refs: { rid: string | undefined; alt?: string }[] = []
  for (const drawing of descendants(p, 'drawing')) {
    const docPr = descendants(drawing, 'docPr')[0]
    const alt = attr(docPr, 'descr')?.trim()
    for (const blip of descendants(drawing, 'blip')) refs.push({ rid: nsAttr(blip, 'embed'), alt })
  }
  for (const img of descendants(p, 'imagedata')) refs.push({ rid: nsAttr(img, 'id') })
  // Alternate content repeats a picture (DrawingML choice, VML fallback): keep each image once.
  const seen = new Set<string>()
  for (const { rid, alt } of refs) {
    const rel = rid === undefined ? undefined : rels.get(rid)
    if (!rel || rel.external || !rel.type.endsWith(REL_IMAGE)) continue
    const id = images.add(rel.target)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    out.push(alt ? { id, alt } : { id })
  }
  return out
}

interface Section {
  level: number
  title: string
  label: string
  path: string[]
  blocks: string[]
  images: UnitImageRef[]
}

interface OpenHeading {
  level: number
  title: string
  ordinal: number
  children: number
}

function cellText(tc: XmlElement, styles: ReadonlyMap<string, StyleInfo>): string {
  const lines: string[] = []
  for (const block of blockChildren(tc)) {
    const n = localName(block.name)
    if (n === 'p') lines.push(listPrefix(block, styles) + runText(block).trim())
    else if (n === 'tbl') lines.push(plainTable(block))
  }
  return lines.filter((l) => l.trim() !== '').join('\n')
}

/** A nested table, flattened (Markdown tables do not nest). */
function plainTable(tbl: XmlElement): string {
  return descendants(tbl, 'p')
    .map((p) => runText(p).trim())
    .filter((t) => t !== '')
    .join(' ; ')
}

/** Columns one cell may span (`gridSpan`); Word itself allows 63. */
const MAX_SPAN = 64

function tableMarkdown(tbl: XmlElement, styles: ReadonlyMap<string, StyleInfo>, budget: TableBudget): string {
  const rows: string[][] = []
  for (const tr of childrenOf(tbl, 'tr')) {
    const row: string[] = []
    for (const tc of childrenOf(tr, 'tc')) {
      const tcPr = childOf(tc, 'tcPr')
      const merged = childOf(tcPr, 'vMerge')
      const continued = merged !== undefined && attr(merged, 'val') !== 'restart'
      row.push(continued ? '' : cellText(tc, styles))
      const span = Number(attr(childOf(tcPr, 'gridSpan'), 'val') ?? 1)
      for (let k = 1; k < Math.min(span, MAX_SPAN); k++) row.push('')
      // Spans multiply the cells: a row wider than what the document has left is refused while it is read.
      budget.check(row.length)
    }
    rows.push(row)
  }
  return tableToMarkdown(rows, budget)
}

/** Block-level children in order, looking through content controls and custom XML wrappers. */
function blockChildren(container: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  const stack: XmlElement[] = []
  for (let k = container.children.length - 1; k >= 0; k--) {
    const c = container.children[k]
    if (isElement(c)) stack.push(c)
  }
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur) break
    const n = localName(cur.name)
    if (n === 'p' || n === 'tbl') {
      out.push(cur)
      continue
    }
    if (n === 'sdt' || n === 'sdtContent' || n === 'customXml' || n === 'ins' || n === 'moveTo') {
      const inner = n === 'sdt' ? [childOf(cur, 'sdtContent')] : cur.children
      for (let k = inner.length - 1; k >= 0; k--) {
        const c = inner[k]
        if (isElement(c)) stack.push(c)
      }
    }
  }
  return out
}

function listPrefix(p: XmlElement, styles: ReadonlyMap<string, StyleInfo>): string {
  const pPr = childOf(p, 'pPr')
  const numPr = childOf(pPr, 'numPr')
  const style = styles.get(attr(childOf(pPr, 'pStyle'), 'val') ?? '')
  if (!numPr && !style?.list) return ''
  const level = Number(attr(childOf(numPr, 'ilvl'), 'val') ?? 0) || 0
  return `${'  '.repeat(Math.min(level, 8))}- `
}

/** Splits an over-long section at block boundaries. */
function split(section: Section): Section[] {
  const parts: Section[] = []
  let cur: Section = { ...section, blocks: [] }
  let size = 0
  for (const block of section.blocks) {
    if (size > 0 && size + block.length > MAX_SECTION_CHARS) {
      parts.push(cur)
      cur = { ...section, blocks: [], images: [] }
      size = 0
    }
    cur.blocks.push(block)
    size += block.length
  }
  parts.push(cur)
  if (parts.length === 1) return parts
  return parts.map((p, k) =>
    k === 0 ? p : { ...p, label: `${p.label} (${k + 1})`, title: p.title ? `${p.title} (${k + 1})` : '' },
  )
}

export function readDocx(data: Uint8Array, options: ReadOfficeOptions): Deck {
  const { limits, signal } = options
  const zip = new ZipReader(data, limits)
  const docPart = mainPart(zip, limits, 'word/document.xml')
  const xml = zip.text(docPart)
  if (xml === null) throw new DeckError('corrupt', 'document part is missing')
  const doc = parseXml(xml, limits)
  const rels = readRels(zip, docPart, limits)
  let stylesPart = 'word/styles.xml'
  for (const rel of rels.values()) if (rel.type.endsWith(REL_STYLES) && !rel.external) stylesPart = rel.target
  const styles = readStyles(zip, stylesPart, limits)
  const warnings: string[] = []
  const images = new ImageCollector(zip, limits, warnings)
  const tables = new TableBudget(limits.maxTableCells)
  const body = childOf(doc, 'body')
  if (!body) throw new DeckError('corrupt', 'document has no body')

  let docTitle = ''
  const sections: Section[] = []
  let current: Section = { level: 0, title: '', label: '0', path: [], blocks: [], images: [] }
  const open: OpenHeading[] = [{ level: 0, title: '', ordinal: 0, children: 0 }]
  let lastWasList = false
  for (const block of blockChildren(body)) {
    signal?.throwIfAborted()
    if (localName(block.name) === 'tbl') {
      lastWasList = false
      const md = tableMarkdown(block, styles, tables)
      if (md !== '') current.blocks.push(md)
      continue
    }
    const pPr = childOf(block, 'pPr')
    const style = styles.get(attr(childOf(pPr, 'pStyle'), 'val') ?? '')
    const text = runText(block).trim()
    current.images.push(...paragraphImages(block, rels, images))
    const level = outlineLevel(pPr) ?? style?.heading
    if (style?.title && level === undefined) {
      if (docTitle === '') docTitle = text.replace(/\s+/g, ' ')
      else if (text !== '') current.blocks.push(text)
      continue
    }
    if (level !== undefined && text !== '') {
      lastWasList = false
      sections.push(current)
      while ((open[open.length - 1]?.level ?? 0) >= level) open.pop()
      const parent = open[open.length - 1] ?? open[0]
      if (!parent) break
      parent.children++
      open.push({ level, title: text.replace(/\s+/g, ' '), ordinal: parent.children, children: 0 })
      const chain = open.slice(1)
      current = {
        level: chain.length,
        title: text.replace(/\s+/g, ' '),
        label: chain.map((h) => h.ordinal).join('.'),
        path: chain.slice(0, -1).map((h) => h.title),
        blocks: [],
        images: [],
      }
      continue
    }
    if (text === '') continue
    const prefix = listPrefix(block, styles)
    const last = current.blocks.length - 1
    // Consecutive list items form one block, as in Markdown.
    if (prefix !== '' && lastWasList && last >= 0) current.blocks[last] += `\n${prefix}${text}`
    else current.blocks.push(prefix + text)
    lastWasList = prefix !== ''
  }
  sections.push(current)

  const units: DeckUnit[] = []
  outer: for (const section of sections) {
    if (section.level === 0 && section.blocks.length === 0 && section.images.length === 0) continue
    for (const part of split(section)) {
      if (units.length >= limits.maxUnits) {
        warnings.push(`unit-limit:${limits.maxUnits}`)
        break outer
      }
      const unit: DeckUnit = {
        index: units.length + 1,
        kind: 'section',
        label: part.label,
        title: part.level === 0 ? docTitle : part.title,
        text: tidyText(part.blocks.join('\n\n')),
        images: part.images,
        level: part.level,
        path: part.path,
      }
      units.push(unit)
    }
  }
  const title =
    coreTitle(zip, limits) || docTitle || titleFromName(options.name) || units.find((u) => u.title)?.title || ''
  return { kind: 'document', format: 'docx', title, units, images: images.images, warnings }
}
