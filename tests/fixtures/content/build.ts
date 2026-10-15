/**
 * Builds the deck fixtures (slides.pptx, notes.docx, slides.pdf) from code, byte for byte reproducibly:
 * fixed zip timestamps, fixed compression level, no randomness. `bun tests/fixtures/content/build.ts`
 * rewrites them; `src/core/content/deck.test.ts` checks the committed files still match.
 */
import { zipSync, zlibSync } from 'fflate'

const enc = new TextEncoder()

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

function chunk(type: string, data: Uint8Array): number[] {
  const body = new Uint8Array([...enc.encode(type), ...data])
  return [...be32(data.length), ...body, ...be32(crc32(body))]
}

/** A solid-colour RGB PNG. */
export function png(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const rows = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 3)
    for (let x = 0; x < width; x++) rows.set(rgb, o + 1 + x * 3)
  }
  const ihdr = new Uint8Array([...be32(width), ...be32(height), 8, 2, 0, 0, 0])
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', zlibSync(rows, { level: 9 })),
    ...chunk('IEND', new Uint8Array(0)),
  ])
}

// --- ZIP ------------------------------------------------------------------------------------------------

/** Local-time components, so the DOS timestamp is the same in every time zone. */
const MTIME = new Date(2020, 0, 1, 0, 0, 0)

export function zip(files: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 6; mtime: Date }]> = {}
  for (const [name, body] of Object.entries(files)) {
    entries[name] = [typeof body === 'string' ? enc.encode(body) : body, { level: 6, mtime: MTIME }]
  }
  return zipSync(entries)
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const NS_P =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

export function rels(list: readonly (readonly [string, string, string])[]): string {
  const items = list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
  return `${XML}<Relationships xmlns="${PKG_REL}">${items.join('')}</Relationships>`
}

function core(title: string): string {
  return (
    `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`
  )
}

// --- PPTX -----------------------------------------------------------------------------------------------

function para(text: string, opts: { lvl?: number; bullet?: 'none' } = {}): string {
  const lvl = opts.lvl ? ` lvl="${opts.lvl}"` : ''
  const bu = opts.bullet === 'none' ? '<a:buNone/>' : ''
  const ppr = lvl || bu ? `<a:pPr${lvl}>${bu}</a:pPr>` : ''
  return `<a:p>${ppr}<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`
}

function sp(id: number, ph: string | null, paras: string): string {
  const phEl = ph === null ? '' : `<p:ph type="${ph}"/>`
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr>${phEl}</p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`
  )
}

function pic(id: number, rid: string, descr: string): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${descr}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
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

function slide(shapes: string, hidden = false): string {
  return `${XML}<p:sld ${NS_P}${hidden ? ' show="0"' : ''}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`
}

function notes(text: string): string {
  return `${XML}<p:notes ${NS_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp(2, 'sldImg', '')}${sp(3, 'body', para(text))}${sp(4, 'sldNum', para('2'))}</p:spTree></p:cSld></p:notes>`
}

const BLUE = png(4, 3, [30, 90, 200])
const GREEN = png(2, 2, [20, 160, 60])

/**
 * Four slides in presentation order: a title slide, « Osmosis » (stored as slide3.xml: order comes from
 * the presentation, not file names), a table slide, and a hidden backup slide.
 */
export function slidesPptx(): Uint8Array {
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>`,
    '_rels/.rels': rels([
      ['rId1', 'officeDocument', 'ppt/presentation.xml'],
      ['rId2', 'metadata/core-properties', 'docProps/core.xml'],
    ]),
    'docProps/core.xml': core('Cell Biology 101'),
    'ppt/presentation.xml': `${XML}<p:presentation ${NS_P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/><p:sldId id="259" r:id="rId5"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([
      ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'slide', 'slides/slide3.xml'],
      ['rId4', 'slide', 'slides/slide2.xml'],
      ['rId5', 'slide', 'slides/slide4.xml'],
    ]),
    'ppt/slides/slide1.xml': slide(
      sp(2, 'ctrTitle', para('Cell Biology 101')) + sp(3, 'subTitle', para('Membranes and transport')),
    ),
    'ppt/slides/_rels/slide1.xml.rels': rels([['rId1', 'notesSlide', '../notesSlides/notesSlide1.xml']]),
    'ppt/notesSlides/notesSlide1.xml': notes('Welcome everyone. Today: membranes.'),
    'ppt/slides/slide3.xml': slide(
      sp(2, 'title', para('Osmosis')) +
        sp(
          3,
          'body',
          para('Diffusion of water across a semi-permeable membrane') +
            para('From low to high solute concentration', { lvl: 1 }),
        ) +
        pic(4, 'rId2', 'Diagram of osmosis') +
        sp(5, 'sldNum', para('2')),
    ),
    'ppt/slides/_rels/slide3.xml.rels': rels([
      ['rId1', 'notesSlide', '../notesSlides/notesSlide2.xml'],
      ['rId2', 'image', '../media/image1.png'],
    ]),
    'ppt/notesSlides/notesSlide2.xml': notes('Stress that water moves, not solutes.'),
    'ppt/slides/slide2.xml': slide(
      sp(2, 'title', para('Transport compared')) +
        table([
          ['Mechanism', 'Energy'],
          ['Diffusion', 'None'],
          ['Active transport', 'ATP'],
        ]) +
        sp(3, null, para('Na&#8314; &amp; K&#8314; pumps')) +
        pic(4, 'rId1', '') +
        pic(5, 'rId2', 'Logo'),
    ),
    'ppt/slides/_rels/slide2.xml.rels': rels([
      ['rId1', 'image', '../media/image2.png'],
      ['rId2', 'image', '../media/image1.png'],
    ]),
    'ppt/slides/slide4.xml': slide(sp(2, 'title', para('Backup')) + sp(3, 'body', para('Extra data')), true),
    'ppt/media/image1.png': BLUE,
    'ppt/media/image2.png': GREEN,
  })
}

// --- DOCX -----------------------------------------------------------------------------------------------

const NS_W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

function wp(text: string, style?: string, extra = ''): string {
  const ppr = style ? `<w:pPr><w:pStyle w:val="${style}"/>${extra}</w:pPr>` : extra ? `<w:pPr>${extra}</w:pPr>` : ''
  return `<w:p>${ppr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

function wcell(text: string, props = ''): string {
  return `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ''}${wp(text)}</w:tc>`
}

const DRAWING =
  '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="Sodium pump"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
  '<pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline>' +
  '</w:drawing></w:r></w:p>'

function style(id: string, name: string, extra = ''): string {
  return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`
}

/**
 * A study document: title, an introduction before any heading, nested headings (one via a custom style
 * based on Heading1), a list, a table with a merged cell, a picture, tracked changes and a content control.
 */
export function notesDocx(): Uint8Array {
  const body = [
    wp('Physiology notes', 'Title'),
    wp('These notes cover membranes &amp; transport.'),
    wp('Membranes', 'Heading1'),
    wp('Membranes separate the cell from its environment.'),
    wp('Osmosis', 'Heading2'),
    wp('Water moves toward higher solute concentration.', 'ListParagraph'),
    wp('Nested point', undefined, '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>'),
    wp('Diffusion', 'Heading2'),
    `<w:tbl><w:tr>${wcell('Solute')}${wcell('Rate')}</w:tr><w:tr>${wcell('O2 | CO2', '<w:gridSpan w:val="2"/>')}</w:tr></w:tbl>`,
    wp('Transport', 'Heading1'),
    DRAWING,
    '<w:p><w:r><w:t xml:space="preserve">Pumps use </w:t></w:r><w:del w:id="1"><w:r><w:delText>WRONG</w:delText></w:r></w:del>' +
      '<w:ins w:id="2"><w:r><w:t>ATP</w:t></w:r></w:ins><w:r><w:tab/><w:t>always.</w:t></w:r></w:p>',
    `<w:sdt><w:sdtPr/><w:sdtContent>${wp('Inside a content control.')}</w:sdtContent></w:sdt>`,
    wp('Appendix', 'MyHeading'),
    wp('Further reading.'),
  ].join('')
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>`,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': `${XML}<w:document ${NS_W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    'word/_rels/document.xml.rels': rels([
      ['rId1', 'styles', 'styles.xml'],
      ['rId5', 'image', 'media/image1.png'],
    ]),
    'word/styles.xml': `${XML}<w:styles ${NS_W}>${[
      style('Title', 'Title'),
      style('Heading1', 'heading 1', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>'),
      style('Heading2', 'heading 2', '<w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>'),
      style('ListParagraph', 'List Paragraph', '<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>'),
      style('MyHeading', 'My heading', '<w:basedOn w:val="Heading1"/>'),
    ].join('')}</w:styles>`,
    'word/media/image1.png': BLUE,
  })
}

// --- PDF ------------------------------------------------------------------------------------------------

export interface PdfPageSpec {
  /** Lines from the top; the first may be set larger as a title. */
  lines: readonly string[]
  titleSize?: number
}

function pdfString(s: string): string {
  return `(${s.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`
}

/** A minimal, valid PDF (Helvetica text only) with an Info dictionary. */
export function pdf(
  pages: readonly PdfPageSpec[],
  o: { width: number; height: number; producer?: string; title?: string; encrypted?: boolean },
): Uint8Array {
  const objs: string[] = []
  objs.push('<< /Type /Catalog /Pages 2 0 R >>')
  const pagesAt = objs.length
  objs.push('')
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const info = [
    o.title ? `/Title ${pdfString(o.title)}` : '',
    o.producer ? `/Producer ${pdfString(o.producer)}` : '',
  ].join(' ')
  objs.push(`<< ${info} >>`)
  // Standard security handler whose check values match no password: readers must ask for one.
  const encrypt = o.encrypted
    ? objs.push(`<< /Filter /Standard /V 1 /R 2 /P -4 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> >>`)
    : 0
  const first = objs.length + 1
  for (const [i, page] of pages.entries()) {
    let y = o.height - 60
    const ops = page.lines.map((line, k) => {
      const size = k === 0 && page.titleSize ? page.titleSize : 14
      const op = `BT /F1 ${size} Tf 40 ${y} Td ${pdfString(line)} Tj ET`
      y -= size + 12
      return op
    })
    const content = ops.join('\n')
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${o.width} ${o.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${first + 1 + i * 2} 0 R >>`,
    )
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  const kids = pages.map((_, i) => `${first + i * 2} 0 R`).join(' ')
  objs[pagesAt] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [i, obj] of objs.entries()) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')
  const security = encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>]` : ''
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 4 0 R${security} >>\nstartxref\n${xref}\n%%EOF\n`
  return enc.encode(out)
}

/** Three 16:9 slides exported from a presentation tool. */
export function slidesPdf(): Uint8Array {
  return pdf(
    [
      { lines: ['Cell Biology 101', 'Membranes and transport'], titleSize: 32 },
      { lines: ['Osmosis', 'Water crosses semi-permeable membranes'], titleSize: 32 },
      { lines: ['Active transport', 'Pumps use ATP'], titleSize: 32 },
    ],
    { width: 720, height: 405, producer: 'Microsoft PowerPoint for Mac', title: 'Cell Biology slides' },
  )
}

export const FIXTURES = {
  'slides.pptx': slidesPptx,
  'notes.docx': notesDocx,
  'slides.pdf': slidesPdf,
} as const

if (import.meta.main) {
  for (const [name, build] of Object.entries(FIXTURES)) {
    await Bun.write(new URL(name, import.meta.url), build())
    console.log(`wrote tests/fixtures/content/${name}`)
  }
}
