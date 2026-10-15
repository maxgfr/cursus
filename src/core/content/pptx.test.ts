import { describe, expect, test } from 'bun:test'
import { png, rels, slidesPptx, zip } from '../../../tests/fixtures/content/build'
import { DEFAULT_DECK_LIMITS, DeckError, deckLimits, importDeck, unitImages } from './deck'
import { readPptx } from './pptx'

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'

/** A one-slide deck around a raw shape tree. */
function oneSlide(shapes: string, extra: Record<string, string | Uint8Array> = {}, slideRels = ''): Uint8Array {
  return zip({
    'ppt/presentation.xml': `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slide', 'slides/slide1.xml']]),
    'ppt/slides/slide1.xml': `<p:sld ${NS}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`,
    ...(slideRels ? { 'ppt/slides/_rels/slide1.xml.rels': slideRels } : {}),
    ...extra,
  })
}

const text = (t: string, ph?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`

describe('pptx', () => {
  test('reads every slide in presentation order with title, text, notes and images', async () => {
    const deck = await importDeck(slidesPptx(), { name: 'cours.pptx' })
    expect(deck.kind).toBe('deck')
    expect(deck.format).toBe('pptx')
    expect(deck.title).toBe('Cell Biology 101')
    expect(deck.warnings).toEqual([])
    expect(deck.units.map((u) => [u.index, u.kind, u.label, u.title])).toEqual([
      [1, 'slide', '1', 'Cell Biology 101'],
      [2, 'slide', '2', 'Osmosis'],
      [3, 'slide', '3', 'Transport compared'],
      [4, 'slide', '4', 'Backup'],
    ])
    const [title, osmosis, compared, backup] = deck.units
    expect(title?.text).toBe('Membranes and transport')
    expect(title?.notes).toBe('Welcome everyone. Today: membranes.')
    expect(osmosis?.text).toBe(
      '- Diffusion of water across a semi-permeable membrane\n  - From low to high solute concentration',
    )
    expect(osmosis?.notes).toBe('Stress that water moves, not solutes.')
    expect(osmosis?.images).toEqual([{ id: 'ppt/media/image1.png', alt: 'Diagram of osmosis' }])
    expect(compared?.text).toBe(
      '| Mechanism | Energy |\n| --- | --- |\n| Diffusion | None |\n| Active transport | ATP |\n\nNa⁺ & K⁺ pumps',
    )
    expect(compared?.notes).toBeUndefined()
    expect(compared?.images).toEqual([{ id: 'ppt/media/image2.png' }, { id: 'ppt/media/image1.png', alt: 'Logo' }])
    expect(backup?.hidden).toBe(true)
    expect(osmosis?.hidden).toBeUndefined()
    // The slide number placeholder is not content.
    expect(osmosis?.text).not.toContain('2\n')
    // A picture used on two slides is stored once.
    expect([...deck.images.keys()]).toEqual(['ppt/media/image1.png', 'ppt/media/image2.png'])
    const imgs = unitImages(deck, osmosis ?? { images: [] })
    expect(imgs[0]?.mime).toBe('image/png')
    expect(imgs[0]?.bytes).toEqual(png(4, 3, [30, 90, 200]))
  })

  test('groups and alternate content are read in order; external and non-image links are ignored', () => {
    const shapes =
      `<p:grpSp>${text('inside group')}</p:grpSp>` +
      `<mc:AlternateContent><mc:Choice Requires="p14">${text('choice')}</mc:Choice><mc:Fallback>${text('fallback')}</mc:Fallback></mc:AlternateContent>` +
      `<mc:AlternateContent><mc:Fallback>${text('only fallback')}</mc:Fallback></mc:AlternateContent>` +
      `<p:pic><p:blipFill><a:blip r:embed="rIdExt"/></p:blipFill></p:pic>` +
      `<p:pic><p:blipFill><a:blip r:embed="rIdNotes"/></p:blipFill></p:pic>` +
      `<p:pic><p:blipFill><a:blip r:embed="rIdNone"/></p:blipFill></p:pic>` +
      `<p:pic><p:blipFill><a:blip/></p:blipFill></p:pic>` +
      text('after')
    const slideRels =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/a.png" TargetMode="External"/>' +
      '<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="../x.xml"/>' +
      '</Relationships>'
    const deck = readPptx(oneSlide(shapes, {}, slideRels), { limits: DEFAULT_DECK_LIMITS, name: 'Fallback name.pptx' })
    expect(deck.units[0]?.text).toBe('inside group\n\nchoice\n\nonly fallback\n\nafter')
    expect(deck.units[0]?.images).toEqual([])
    expect(deck.title).toBe('Fallback name')
  })

  test('explicit bullets, buNone, line breaks and fields', () => {
    const shapes =
      '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>' +
      '<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>no bullet</a:t></a:r></a:p>' +
      '<a:p><a:r><a:t>line</a:t></a:r><a:br/><a:r><a:t>break</a:t></a:r></a:p>' +
      '<a:p><a:fld type="slidenum"><a:t>7</a:t></a:fld></a:p><a:p></a:p></p:txBody></p:sp>' +
      '<p:sp><p:txBody><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>box bullet</a:t></a:r></a:p></p:txBody></p:sp>'
    const deck = readPptx(oneSlide(shapes), { limits: DEFAULT_DECK_LIMITS })
    expect(deck.units[0]?.text).toBe('no bullet\n- line\nbreak\n- 7\n\n- box bullet')
    expect(deck.units[0]?.title).toBe('')
    expect(deck.title).toBe('')
  })

  test('without a core title or a file name, the first slide title names the deck', () => {
    const deck = readPptx(oneSlide(text('Only title', 'title')), { limits: DEFAULT_DECK_LIMITS })
    expect(deck.title).toBe('Only title')
  })

  test('image limits skip pictures with a warning instead of failing', () => {
    const pics =
      '<p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic>' +
      '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>' +
      '<p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic>' +
      '<p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic>'
    const slideRels = rels([
      ['rId1', 'image', '../media/small.png'],
      ['rId2', 'image', '../media/big.png'],
      ['rId3', 'image', '../media/missing.png'],
    ])
    const data = oneSlide(
      pics,
      { 'ppt/media/small.png': png(1, 1, [0, 0, 0]), 'ppt/media/big.png': new Uint8Array(5000) },
      slideRels,
    )
    const deck = readPptx(data, { limits: deckLimits({ maxImageBytes: 1000 }) })
    expect(deck.units[0]?.images).toEqual([{ id: 'ppt/media/small.png' }])
    expect(deck.warnings).toEqual(['image-too-large:ppt/media/big.png', 'image-missing:ppt/media/missing.png'])
    const capped = readPptx(data, { limits: deckLimits({ maxImages: 0 }) })
    expect(capped.units[0]?.images).toEqual([])
    expect(capped.warnings[0]).toBe('image-limit:ppt/media/small.png')
  })

  test('a deck over the slide limit keeps the first slides and says so', () => {
    const deck = readPptx(slidesPptx(), { limits: deckLimits({ maxUnits: 2 }) })
    expect(deck.units.map((u) => u.title)).toEqual(['Cell Biology 101', 'Osmosis'])
    expect(deck.warnings).toEqual(['unit-limit:4'])
  })

  test('a slide listed but missing is skipped with a warning; a missing presentation is corrupt', () => {
    const data = zip({
      'ppt/presentation.xml': `<p:presentation ${NS}><p:sldIdLst><p:sldId id="1" r:id="rId1"/><p:sldId id="2" r:id="rIdX"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slide', 'slides/gone.xml']]),
    })
    const deck = readPptx(data, { limits: DEFAULT_DECK_LIMITS })
    expect(deck.units).toEqual([])
    expect(deck.warnings).toEqual(['slide-missing:ppt/slides/gone.xml'])
    const broken = zip({
      '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/elsewhere.xml']]),
      'ppt/presentation.xml': '<x/>',
    })
    expect(() => readPptx(broken, { limits: DEFAULT_DECK_LIMITS })).toThrow(DeckError)
  })

  test('notes without a body placeholder are empty; slides without a shape tree are empty', () => {
    const data = oneSlide(
      text('t', 'title'),
      { 'ppt/notesSlides/n.xml': `<p:notes ${NS}><p:cSld/></p:notes>` },
      rels([['rId1', 'notesSlide', '../notesSlides/n.xml']]),
    )
    expect(readPptx(data, { limits: DEFAULT_DECK_LIMITS }).units[0]?.notes).toBeUndefined()
  })

  test('an aborted read stops between slides', () => {
    const ctl = new AbortController()
    ctl.abort()
    expect(() => readPptx(slidesPptx(), { limits: DEFAULT_DECK_LIMITS, signal: ctl.signal })).toThrow()
  })
})

describe('tables against the cell budget', () => {
  const frame = (rows: string) =>
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/>' +
    '</p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    `<a:tbl>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  const cell = '<a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc>'

  test('one wide row and many empty rows are refused (too-large), not padded into memory', () => {
    const hostile = oneSlide(frame(`<a:tr h="0">${cell.repeat(50)}</a:tr>${'<a:tr h="0"/>'.repeat(30)}`))
    expect(() => readPptx(hostile, { limits: deckLimits({ maxTableCells: 1_000 }) })).toThrow(
      expect.objectContaining({ name: 'DeckError', kind: 'too-large' }),
    )
    const fine = readPptx(oneSlide(frame(`<a:tr h="0">${cell.repeat(5)}</a:tr>`)), { limits: DEFAULT_DECK_LIMITS })
    expect(fine.units[0]?.text).toContain('| --- | --- | --- | --- | --- |')
  })
})
