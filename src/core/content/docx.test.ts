import { describe, expect, test } from 'bun:test'
import { notesDocx, png, rels, zip } from '../../../tests/fixtures/content/build'
import { DEFAULT_DECK_LIMITS, DeckError, deckLimits, importDeck } from './deck'
import { MAX_SECTION_CHARS, readDocx } from './docx'

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml"'

function doc(body: string, extra: Record<string, string | Uint8Array> = {}): Uint8Array {
  return zip({ 'word/document.xml': `<w:document ${NS}><w:body>${body}</w:body></w:document>`, ...extra })
}

const p = (t: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t>${t}</w:t></w:r></w:p>`
const h = (level: number, t: string) => p(t, `<w:outlineLvl w:val="${level - 1}"/>`)

describe('docx', () => {
  test('headings become hierarchical sections with their text, lists, tables and images', async () => {
    const deck = await importDeck(notesDocx(), { name: 'notes.docx' })
    expect(deck.kind).toBe('document')
    expect(deck.format).toBe('docx')
    expect(deck.title).toBe('Physiology notes')
    expect(deck.warnings).toEqual([])
    expect(deck.units.map((u) => [u.index, u.kind, u.label, u.title, u.level, u.path])).toEqual([
      [1, 'section', '0', 'Physiology notes', 0, []],
      [2, 'section', '1', 'Membranes', 1, []],
      [3, 'section', '1.1', 'Osmosis', 2, ['Membranes']],
      [4, 'section', '1.2', 'Diffusion', 2, ['Membranes']],
      [5, 'section', '2', 'Transport', 1, []],
      [6, 'section', '3', 'Appendix', 1, []],
    ])
    const text = deck.units.map((u) => u.text)
    expect(text[0]).toBe('These notes cover membranes & transport.')
    expect(text[2]).toBe('- Water moves toward higher solute concentration.\n  - Nested point')
    expect(text[3]).toBe('| Solute | Rate |\n| --- | --- |\n| O2 \\| CO2 | |')
    // Tracked deletion dropped, insertion kept, tab as space, content control read.
    expect(text[4]).toBe('Pumps use ATP always.\n\nInside a content control.')
    expect(deck.units[4]?.images).toEqual([{ id: 'word/media/image1.png', alt: 'Sodium pump' }])
    expect(deck.images.get('word/media/image1.png')?.bytes).toEqual(png(4, 3, [30, 90, 200]))
  })

  test('skipped heading levels still number by nesting', () => {
    const deck = readDocx(doc(h(1, 'A') + h(3, 'deep') + p('x') + h(2, 'B') + h(1, 'C') + h(4, 'D')), {
      limits: DEFAULT_DECK_LIMITS,
    })
    expect(deck.units.map((u) => [u.label, u.title, u.level])).toEqual([
      ['1', 'A', 1],
      ['1.1', 'deep', 2],
      ['1.2', 'B', 2],
      ['2', 'C', 1],
      ['2.1', 'D', 2],
    ])
  })

  test('a document without headings is one section titled after the file', () => {
    const deck = readDocx(doc(`${p('Just text.')}${p('More.')}<w:p/>`), {
      limits: DEFAULT_DECK_LIMITS,
      name: 'Plain.docx',
    })
    expect(deck.units).toHaveLength(1)
    expect(deck.units[0]).toMatchObject({ label: '0', title: '', text: 'Just text.\n\nMore.' })
    expect(deck.title).toBe('Plain')
  })

  test('a long section is split into parts at paragraph boundaries', () => {
    const para = 'word '.repeat(400).trim()
    const n = Math.ceil((MAX_SECTION_CHARS * 2.5) / para.length)
    const deck = readDocx(doc(h(1, 'Long') + p(para).repeat(n) + h(1, 'Short') + p('x')), {
      limits: DEFAULT_DECK_LIMITS,
    })
    expect(deck.units.map((u) => [u.label, u.title])).toEqual([
      ['1', 'Long'],
      ['1 (2)', 'Long (2)'],
      ['1 (3)', 'Long (3)'],
      ['2', 'Short'],
    ])
    for (const u of deck.units) expect(u.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS + para.length)
    expect(deck.units.map((u) => u.index)).toEqual([1, 2, 3, 4])
  })

  test('VML pictures, alternate content and nested tables', () => {
    const body =
      '<w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId1"/></v:shape></w:pict></w:r></w:p>' +
      '<w:p><w:r><mc:AlternateContent><mc:Choice><w:t>choice</w:t></mc:Choice><mc:Fallback><w:t>fallback</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>' +
      `<w:tbl><w:tr><w:tc>${p('outer')}<w:tbl><w:tr><w:tc>${p('in1')}</w:tc><w:tc>${p('in2')}</w:tc></w:tr></w:tbl></w:tc></w:tr>` +
      `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>${p('hidden by merge')}</w:tc></w:tr></w:tbl>` +
      '<w:p><w:r><w:t>line</w:t><w:br/><w:t>two</w:t><w:noBreakHyphen/><w:t>x</w:t><w:instrText>PAGE</w:instrText></w:r></w:p>'
    const deck = readDocx(
      doc(body, {
        'word/_rels/document.xml.rels': rels([['rId1', 'image', 'media/v.png']]),
        'word/media/v.png': png(1, 1, [1, 2, 3]),
      }),
      { limits: DEFAULT_DECK_LIMITS },
    )
    expect(deck.units[0]?.images).toEqual([{ id: 'word/media/v.png' }])
    expect(deck.units[0]?.text).toBe('choice\n\n| outer <br> in1 ; in2 |\n| --- |\n| |\n\nline\ntwo-x')
  })

  test('a table whose spans and empty rows pass the cell budget is refused (too-large)', async () => {
    const span = `<w:tc><w:tcPr><w:gridSpan w:val="64"/></w:tcPr>${p('x')}</w:tc>`
    // 20 cells spanning 64 columns each: one row 1,280 cells wide, refused while it is read.
    const wide = doc(`<w:tbl><w:tr>${span.repeat(20)}</w:tr></w:tbl>`)
    const limits = deckLimits({ maxTableCells: 1_000 })
    expect(() => readDocx(wide, { limits })).toThrow(expect.objectContaining({ name: 'DeckError', kind: 'too-large' }))
    // A modest row and many empty rows: padded, it passes the budget too.
    const tall = doc(`<w:tbl><w:tr>${span.repeat(10)}</w:tr>${'<w:tr/>'.repeat(5)}</w:tbl>`)
    expect(() => readDocx(tall, { limits })).toThrow(expect.objectContaining({ kind: 'too-large' }))
    // Within the budget the same table reads as usual, spans padded.
    const fine = readDocx(doc(`<w:tbl><w:tr>${span.repeat(2)}</w:tr></w:tbl>`), { limits })
    expect(fine.units[0]?.text.split('\n')[1]).toBe(`|${' --- |'.repeat(128)}`)
  })

  test('a section limit keeps the first sections and says so', () => {
    const deck = readDocx(notesDocx(), { limits: deckLimits({ maxUnits: 2 }) })
    expect(deck.units).toHaveLength(2)
    expect(deck.warnings).toEqual(['unit-limit:2'])
  })

  test('a document without a body or main part is corrupt', () => {
    expect(() =>
      readDocx(zip({ 'word/document.xml': `<w:document ${NS}/>` }), { limits: DEFAULT_DECK_LIMITS }),
    ).toThrow(DeckError)
    expect(() =>
      readDocx(zip({ '_rels/.rels': rels([['rId1', 'officeDocument', 'word/other.xml']]) }), {
        limits: DEFAULT_DECK_LIMITS,
      }),
    ).toThrow(DeckError)
  })

  test('a style cycle in basedOn does not hang', () => {
    const styles =
      `<w:styles ${NS}><w:style w:styleId="A"><w:name w:val="a"/><w:basedOn w:val="B"/></w:style>` +
      '<w:style w:styleId="B"><w:name w:val="b"/><w:basedOn w:val="A"/></w:style><w:style><w:name w:val="no id"/></w:style></w:styles>'
    const deck = readDocx(doc(p('x', '<w:pStyle w:val="A"/>'), { 'word/styles.xml': styles }), {
      limits: DEFAULT_DECK_LIMITS,
    })
    expect(deck.units.map((u) => u.text)).toEqual(['x'])
  })

  test('a second Title paragraph is body text', () => {
    const styles = `<w:styles ${NS}><w:style w:styleId="T"><w:name w:val="Title"/></w:style></w:styles>`
    const deck = readDocx(doc(p('First', '<w:pStyle w:val="T"/>') + p('Second', '<w:pStyle w:val="T"/>')), {
      limits: DEFAULT_DECK_LIMITS,
    })
    expect(deck.units[0]?.text).toBe('First\n\nSecond')
    const styled = readDocx(
      doc(p('First', '<w:pStyle w:val="T"/>') + p('Second', '<w:pStyle w:val="T"/>'), { 'word/styles.xml': styles }),
      { limits: DEFAULT_DECK_LIMITS },
    )
    expect(styled.title).toBe('First')
    expect(styled.units[0]?.text).toBe('Second')
  })

  test('an aborted read stops', () => {
    const ctl = new AbortController()
    ctl.abort()
    expect(() => readDocx(notesDocx(), { limits: DEFAULT_DECK_LIMITS, signal: ctl.signal })).toThrow()
  })
})
