/**
 * PowerPoint `.pptx`: each slide in presentation order, with its title, text (bullets, tables), speaker
 * notes and pictures. Pure: fflate and the small XML reader of `deck.ts`, no DOM.
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

export interface ReadOfficeOptions {
  name?: string
  limits: DeckLimits
  signal?: AbortSignal
}

const REL_OFFICE_DOCUMENT = '/officeDocument'
const REL_NOTES = '/notesSlide'
const REL_IMAGE = '/image'
const TITLE_TYPES = new Set(['title', 'ctrTitle'])
/** Placeholders that repeat on every slide and say nothing about its content. */
const CHROME_TYPES = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg'])
/** Placeholders whose paragraphs are bullets unless told otherwise. */
const BULLET_TYPES = new Set(['body', 'obj', ''])

/** The main part declared in `_rels/.rels`, else the conventional path. */
export function mainPart(zip: ZipReader, limits: DeckLimits, fallback: string): string {
  for (const rel of readRels(zip, '', limits).values()) {
    if (rel.type.endsWith(REL_OFFICE_DOCUMENT) && !rel.external) return rel.target
  }
  return fallback
}

/** `dc:title` of `docProps/core.xml`, if any. */
export function coreTitle(zip: ZipReader, limits: DeckLimits): string {
  const xml = zip.text('docProps/core.xml')
  if (xml === null) return ''
  const title = descendants(parseXml(xml, limits), 'title')[0]
  return title ? tidyText(plainText(title)) : ''
}

/** Every text node under an element, concatenated. */
export function plainText(el: XmlElement): string {
  let out = ''
  const stack: (XmlElement | string)[] = [el]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (cur === undefined) break
    if (typeof cur === 'string') {
      out += cur
      continue
    }
    for (let k = cur.children.length - 1; k >= 0; k--) {
      const c = cur.children[k]
      if (c !== undefined) stack.push(c)
    }
  }
  return out
}

/** Text of one DrawingML paragraph (`a:p`): runs, fields and line breaks. */
function paragraphText(p: XmlElement): string {
  let out = ''
  for (const c of p.children) {
    if (!isElement(c)) continue
    const n = localName(c.name)
    const t = n === 'r' || n === 'fld' ? childOf(c, 't') : undefined
    if (t) out += plainText(t)
    else if (n === 'br') out += '\n'
  }
  return out
}

function placeholderType(sp: XmlElement): string | undefined {
  const nv = childOf(sp, 'nvSpPr') ?? childOf(sp, 'nvGraphicFramePr') ?? childOf(sp, 'nvPicPr')
  const ph = childOf(childOf(nv, 'nvPr'), 'ph')
  if (!ph) return undefined
  return attr(ph, 'type') ?? ''
}

/** Lines of a text body; bullets as `- `, indented by level. */
function bodyLines(txBody: XmlElement | undefined, bulleted: boolean): string[] {
  if (!txBody) return []
  const lines: string[] = []
  for (const p of childrenOf(txBody, 'p')) {
    const text = paragraphText(p).trim()
    if (text === '') continue
    const pPr = childOf(p, 'pPr')
    const level = Number(attr(pPr, 'lvl') ?? 0) || 0
    const none = childOf(pPr, 'buNone') !== undefined
    const explicit = childOf(pPr, 'buChar') !== undefined || childOf(pPr, 'buAutoNum') !== undefined
    if ((bulleted && !none) || explicit) lines.push(`${'  '.repeat(Math.min(level, 8))}- ${text}`)
    else lines.push(text)
  }
  return lines
}

function tableMarkdown(tbl: XmlElement, budget: TableBudget): string {
  const rows = childrenOf(tbl, 'tr').map((tr) =>
    childrenOf(tr, 'tc').map((tc) => bodyLines(childOf(tc, 'txBody'), false).join('\n')),
  )
  return tableToMarkdown(rows, budget)
}

interface SlideContent {
  title: string
  blocks: string[]
  images: UnitImageRef[]
}

/** Walks a shape tree in document order (groups and alternate content included). */
function walkShapes(
  tree: XmlElement,
  rels: ReadonlyMap<string, Relationship>,
  images: ImageCollector,
  into: SlideContent,
  tables: TableBudget,
): void {
  // Depth-first in document order: a group's shapes come where the group stands.
  const stack: XmlElement[] = []
  const pushChildren = (el: XmlElement): void => {
    for (let k = el.children.length - 1; k >= 0; k--) {
      const c = el.children[k]
      if (isElement(c)) stack.push(c)
    }
  }
  pushChildren(tree)
  while (stack.length > 0) {
    const c = stack.pop()
    if (!c) break
    const n = localName(c.name)
    if (n === 'grpSp') {
      pushChildren(c)
      continue
    }
    if (n === 'AlternateContent') {
      const choice = childOf(c, 'Choice') ?? childOf(c, 'Fallback')
      if (choice) pushChildren(choice)
      continue
    }
    if (n === 'sp') {
      const type = placeholderType(c)
      if (type !== undefined && CHROME_TYPES.has(type)) continue
      const isTitle = type !== undefined && TITLE_TYPES.has(type)
      const lines = bodyLines(childOf(c, 'txBody'), !isTitle && type !== undefined && BULLET_TYPES.has(type))
      if (isTitle && into.title === '') into.title = lines.join(' ').replace(/\s+/g, ' ').trim()
      else if (lines.length > 0) into.blocks.push(lines.join('\n'))
    } else if (n === 'graphicFrame') {
      for (const tbl of descendants(c, 'tbl')) {
        const md = tableMarkdown(tbl, tables)
        if (md !== '') into.blocks.push(md)
      }
    } else if (n === 'pic') {
      const blip = descendants(c, 'blip')[0]
      const rid = nsAttr(blip, 'embed')
      const rel = rid === undefined ? undefined : rels.get(rid)
      if (!rel || rel.external || !rel.type.endsWith(REL_IMAGE)) continue
      const id = images.add(rel.target)
      if (id === undefined) continue
      const alt = attr(childOf(childOf(c, 'nvPicPr'), 'cNvPr'), 'descr')?.trim()
      into.images.push(alt ? { id, alt } : { id })
    }
  }
}

function notesText(zip: ZipReader, part: string, limits: DeckLimits): string {
  const xml = zip.text(part)
  if (xml === null) return ''
  const tree = childOf(childOf(parseXml(xml, limits), 'cSld'), 'spTree')
  if (!tree) return ''
  const blocks: string[] = []
  for (const sp of descendants(tree, 'sp')) {
    const type = placeholderType(sp)
    if (type !== undefined && type !== 'body') continue
    const lines = bodyLines(childOf(sp, 'txBody'), false)
    if (lines.length > 0) blocks.push(lines.join('\n'))
  }
  return tidyText(blocks.join('\n\n'))
}

export function readPptx(data: Uint8Array, options: ReadOfficeOptions): Deck {
  const { limits, signal } = options
  const zip = new ZipReader(data, limits)
  const presPart = mainPart(zip, limits, 'ppt/presentation.xml')
  const presXml = zip.text(presPart)
  if (presXml === null) throw new DeckError('corrupt', 'presentation part is missing')
  const pres = parseXml(presXml, limits)
  const presRels = readRels(zip, presPart, limits)
  const slideParts: string[] = []
  for (const sldId of descendants(childOf(pres, 'sldIdLst') ?? pres, 'sldId')) {
    const rid = nsAttr(sldId, 'id')
    const rel = rid === undefined ? undefined : presRels.get(rid)
    if (rel && !rel.external) slideParts.push(rel.target)
  }
  const warnings: string[] = []
  if (slideParts.length > limits.maxUnits) {
    warnings.push(`unit-limit:${slideParts.length}`)
    slideParts.length = limits.maxUnits
  }
  const images = new ImageCollector(zip, limits, warnings)
  const tables = new TableBudget(limits.maxTableCells)
  const units: DeckUnit[] = []
  for (const [k, part] of slideParts.entries()) {
    signal?.throwIfAborted()
    const xml = zip.text(part)
    if (xml === null) {
      warnings.push(`slide-missing:${part}`)
      continue
    }
    const sld = parseXml(xml, limits)
    const rels = readRels(zip, part, limits)
    const content: SlideContent = { title: '', blocks: [], images: [] }
    const tree = childOf(childOf(sld, 'cSld'), 'spTree')
    if (tree) walkShapes(tree, rels, images, content, tables)
    let notes = ''
    for (const rel of rels.values()) {
      if (rel.type.endsWith(REL_NOTES) && !rel.external) notes = notesText(zip, rel.target, limits)
    }
    const index = k + 1
    const unit: DeckUnit = {
      index,
      kind: 'slide',
      label: String(index),
      title: content.title,
      text: tidyText(content.blocks.join('\n\n')),
      images: content.images,
    }
    if (notes !== '') unit.notes = notes
    if (attr(sld, 'show') === '0') unit.hidden = true
    units.push(unit)
  }
  const title = coreTitle(zip, limits) || titleFromName(options.name) || units.find((u) => u.title)?.title || ''
  return { kind: 'deck', format: 'pptx', title, units, images: images.images, warnings }
}
