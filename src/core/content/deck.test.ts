import { describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import { FIXTURES, rels, zip } from '../../../tests/fixtures/content/build'
import {
  attr,
  DEFAULT_DECK_LIMITS,
  DeckError,
  type DeckErrorKind,
  deckLimits,
  decodeXmlText,
  descendants,
  detectDeckFormat,
  importDeck,
  isVisionImage,
  mimeOfPath,
  nsAttr,
  parseXml,
  relsPathOf,
  resolvePart,
  sourceFieldsOf,
  TableBudget,
  tableToMarkdown,
  tidyText,
  titleFromName,
  unitImages,
  ZipReader,
} from './deck'

const FIXTURE_DIR = new URL('../../../tests/fixtures/content/', import.meta.url)
const enc = new TextEncoder()

async function deckError(p: Promise<unknown> | (() => unknown)): Promise<DeckErrorKind | string> {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    return e instanceof DeckError ? e.kind : `not a DeckError: ${String(e)}`
  }
  return 'no error'
}

/** Rewrites the uncompressed size of the only entry, in both headers: a lying archive. */
function lieAboutSize(data: Uint8Array, size: number): Uint8Array {
  const out = data.slice()
  const view = new DataView(out.buffer)
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = view.getUint32(i, true)
    if (sig === 0x04034b50) view.setUint32(i + 22, size, true)
    if (sig === 0x02014b50) view.setUint32(i + 24, size, true)
  }
  return out
}

describe('fixtures', () => {
  test('the committed fixtures are exactly what the build script produces', async () => {
    for (const [name, build] of Object.entries(FIXTURES)) {
      const committed = await Bun.file(new URL(name, FIXTURE_DIR)).bytes()
      expect({ name, same: Buffer.from(committed).equals(Buffer.from(build())) }).toEqual({ name, same: true })
    }
  })
})

describe('format detection', () => {
  test('recognizes PDF, PowerPoint and Word from the bytes', () => {
    expect(detectDeckFormat(FIXTURES['slides.pdf']())).toBe('pdf')
    expect(detectDeckFormat(FIXTURES['slides.pptx']())).toBe('pptx')
    expect(detectDeckFormat(FIXTURES['notes.docx']())).toBe('docx')
  })

  test('password-protected Office files are reported as such, legacy ones as unsupported', async () => {
    const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
    const utf16 = (s: string) => [...s].flatMap((c) => [c.charCodeAt(0), 0])
    const encrypted = new Uint8Array([...ole, ...new Array(600).fill(0), ...utf16('EncryptedPackage')])
    expect(await deckError(() => detectDeckFormat(encrypted))).toBe('encrypted')
    const legacy = new Uint8Array([...ole, ...new Array(600).fill(0), ...utf16('PowerPoint Document')])
    expect(await deckError(() => detectDeckFormat(legacy))).toBe('unsupported')
  })

  test('other files and other archives are unsupported', async () => {
    expect(await deckError(() => detectDeckFormat(enc.encode('hello')))).toBe('unsupported')
    expect(await deckError(() => detectDeckFormat(zip({ 'a.txt': 'x' })))).toBe('unsupported')
    expect(await deckError(importDeck(enc.encode('GIF89a')))).toBe('unsupported')
  })

  test('a file over the size limit is refused before it is read', async () => {
    const data = FIXTURES['slides.pptx']()
    expect(await deckError(importDeck(data, { limits: { maxFileBytes: 100 } }))).toBe('too-large')
  })

  test('an aborted import stops before reading', async () => {
    const ctl = new AbortController()
    ctl.abort()
    await expect(importDeck(FIXTURES['slides.pptx'](), { signal: ctl.signal })).rejects.toThrow()
  })
})

describe('xml reader', () => {
  test('reads elements, attributes, text, CDATA and character references', () => {
    const doc = parseXml(
      `<?xml version="1.0"?><!-- c --><r a='1' b="x &amp; y"><t>A &lt; B &#65;&#x42;</t><![CDATA[<raw>]]><e/></r>`,
    )
    expect(doc.name).toBe('r')
    expect(attr(doc, 'b')).toBe('x & y')
    expect(attr(doc, 'a')).toBe('1')
    expect(doc.children).toEqual([
      { name: 't', attrs: {}, children: ['A < B AB'] },
      '<raw>',
      { name: 'e', attrs: {}, children: [] },
    ])
  })

  test('never expands entities: unknown references stay literal, invalid code points are replaced', () => {
    expect(decodeXmlText('&lol9; &amp;lt; &#0; &#xD800; &#x1F600;')).toBe('&lol9; &lt; � � 😀')
  })

  test('refuses a document type declaration (billion laughs)', async () => {
    const lol = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>`
    expect(await deckError(() => parseXml(lol))).toBe('unsafe')
  })

  test('bounds depth and node count without recursion', async () => {
    const deep = `${'<a>'.repeat(5000)}${'</a>'.repeat(5000)}`
    expect(await deckError(() => parseXml(deep))).toBe('too-large')
    const wide = `<r>${'<i/>'.repeat(200)}</r>`
    expect(await deckError(() => parseXml(wide, { maxXmlDepth: 10, maxXmlNodes: 100 }))).toBe('too-large')
  })

  test('malformed documents are corrupt', async () => {
    for (const bad of [
      '<a><b></a>',
      '<a>',
      '<a b></a>',
      '<a b=c></a>',
      '<a b="c></a>',
      '<!-- x',
      '<![CDATA[x',
      '<? x',
      '<a></b',
      '< a/>',
      'text only',
      '<a/><b/>',
      '</a>',
    ]) {
      expect({ bad, kind: await deckError(() => parseXml(bad)) }).toEqual({ bad, kind: 'corrupt' })
    }
  })

  test('an attribute named __proto__ is only an attribute', () => {
    const el = parseXml('<a __proto__="x" r:id="rId1" id="7"/>')
    expect(attr(el, '__proto__')).toBe('x')
    expect(attr(el, 'id')).toBe('7')
    expect(nsAttr(el, 'id')).toBe('rId1')
    expect(nsAttr(el, 'missing')).toBeUndefined()
    expect(Object.getPrototypeOf(el.attrs)).toBeNull()
  })

  test('descendants are listed in document order', () => {
    const el = parseXml('<r><x n="1"><x n="2"/></x><y><x n="3"/></y></r>')
    expect(descendants(el, 'x').map((x) => attr(x, 'n'))).toEqual(['1', '2', '3'])
  })
})

describe('zip reader', () => {
  test('reads stored and deflated parts case-insensitively', () => {
    const data = zipSync({
      'A/Stored.txt': [enc.encode('plain'), { level: 0 }],
      'b.txt': [enc.encode('x'.repeat(1000)), { level: 9 }],
    })
    const z = new ZipReader(data, DEFAULT_DECK_LIMITS)
    expect(z.text('a/stored.txt')).toBe('plain')
    expect(z.text('b.txt')).toBe('x'.repeat(1000))
    expect(z.read('missing')).toBeNull()
    expect(z.sizeOf('b.txt')).toBe(1000)
  })

  test('a zip bomb is refused from its declared size, before inflating', async () => {
    const bomb = zip({ 'big.xml': new Uint8Array(50 * 1024 * 1024) })
    expect(bomb.length).toBeLessThan(200_000)
    const z = new ZipReader(bomb, deckLimits({ maxPartBytes: 1024 * 1024 }))
    const started = performance.now()
    expect(await deckError(() => z.read('big.xml'))).toBe('too-large')
    expect(performance.now() - started).toBeLessThan(100)
  })

  test('a header lying about its size cannot inflate beyond it', async () => {
    const liar = lieAboutSize(zip({ 'big.xml': new Uint8Array(20 * 1024 * 1024) }), 1000)
    const z = new ZipReader(liar, DEFAULT_DECK_LIMITS)
    const started = performance.now()
    expect(await deckError(() => z.read('big.xml'))).toBe('too-large')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test('a header claiming more than the content holds is corrupt', async () => {
    const z = new ZipReader(lieAboutSize(zip({ 'a.xml': 'abc'.repeat(100) }), 5000), DEFAULT_DECK_LIMITS)
    expect(await deckError(() => z.read('a.xml'))).toBe('corrupt')
  })

  test('the total inflated across parts is capped', async () => {
    const data = zip({ 'a.xml': new Uint8Array(600), 'b.xml': new Uint8Array(600) })
    const z = new ZipReader(data, deckLimits({ maxUncompressedBytes: 1000 }))
    expect(z.read('a.xml')?.length).toBe(600)
    expect(await deckError(() => z.read('b.xml'))).toBe('too-large')
  })

  test('damaged, truncated, encrypted and ZIP64 archives fail with a typed error', async () => {
    const good = zip({ 'a.xml': '<a/>' })
    expect(await deckError(() => new ZipReader(good.subarray(0, 10), DEFAULT_DECK_LIMITS))).toBe('corrupt')
    const noLocal = good.slice()
    noLocal[0] = 0
    expect(await deckError(() => new ZipReader(noLocal, DEFAULT_DECK_LIMITS).read('a.xml'))).toBe('corrupt')
    const encrypted = good.slice()
    const view = new DataView(encrypted.buffer)
    for (let i = 0; i + 4 <= encrypted.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint16(i + 8, 1, true)
    }
    expect(await deckError(() => new ZipReader(encrypted, DEFAULT_DECK_LIMITS).read('a.xml'))).toBe('encrypted')
    const zip64 = lieAboutSize(good, 0xffffffff)
    expect(await deckError(() => new ZipReader(zip64, DEFAULT_DECK_LIMITS))).toBe('unsupported')
    const tooMany = zip({ a: 'x', b: 'y', c: 'z' })
    expect(await deckError(() => new ZipReader(tooMany, deckLimits({ maxEntries: 2 })))).toBe('too-large')
    const damagedDir = good.slice()
    const dv = new DataView(damagedDir.buffer)
    for (let i = 0; i + 4 <= damagedDir.length; i++) if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i, 0, true)
    expect(await deckError(() => new ZipReader(damagedDir, DEFAULT_DECK_LIMITS))).toBe('corrupt')
  })

  test('an unknown compression method is unsupported', async () => {
    const data = zipSync({ 'a.xml': [enc.encode('<a/>'), { level: 0 }] })
    const view = new DataView(data.buffer)
    for (let i = 0; i + 4 <= data.length; i++)
      if (view.getUint32(i, true) === 0x02014b50) view.setUint16(i + 10, 12, true)
    expect(await deckError(() => new ZipReader(data, DEFAULT_DECK_LIMITS).read('a.xml'))).toBe('unsupported')
  })

  test('an office file whose XML declares a DTD is refused as unsafe', async () => {
    const data = zip({
      '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
      'ppt/presentation.xml': '<!DOCTYPE p [<!ENTITY x "x">]><p:presentation/>',
    })
    expect(await deckError(importDeck(data))).toBe('unsafe')
  })

  test('an office file with a bomb part is refused, not hung on', async () => {
    const data = zip({
      'ppt/presentation.xml': new Uint8Array(64 * 1024 * 1024),
    })
    const started = performance.now()
    expect(await deckError(importDeck(data))).toBe('too-large')
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('helpers', () => {
  test('relationship targets resolve against their part', () => {
    expect(resolvePart('ppt/slides/slide1.xml', '../media/image1.png')).toBe('ppt/media/image1.png')
    expect(resolvePart('word/document.xml', 'media/./a.png')).toBe('word/media/a.png')
    expect(resolvePart('ppt/slides/slide1.xml', '/ppt/x.xml')).toBe('ppt/x.xml')
    expect(resolvePart('', 'ppt/presentation.xml')).toBe('ppt/presentation.xml')
    expect(relsPathOf('ppt/slides/slide1.xml')).toBe('ppt/slides/_rels/slide1.xml.rels')
    expect(relsPathOf('')).toBe('_rels/.rels')
  })

  test('tables become Markdown, cells escaped and padded', () => {
    expect(
      tableToMarkdown([
        ['A', 'B|C'],
        ['1', 'two\nlines', 'extra'],
      ]),
    ).toBe('| A | B\\|C |  |\n| --- | --- | --- |\n| 1 | two <br> lines | extra |')
    expect(tableToMarkdown([])).toBe('')
  })

  test('a table padded past the cell budget is refused before it is built', async () => {
    // One wide row and many empty ones: a few KB of XML asking for millions of cells.
    const rows = [Array.from({ length: 2_000 }, () => ''), ...Array.from({ length: 1_000 }, () => [])]
    expect(await deckError(() => tableToMarkdown(rows))).toBe('too-large')
    // The budget is per document: tables that fit alone are refused once together they pass it.
    const budget = new TableBudget(100)
    expect(tableToMarkdown([['a', 'b'], ...Array.from({ length: 29 }, () => ['x'])], budget)).toContain('| a | b |')
    expect(await deckError(() => tableToMarkdown([['a', 'b'], ...Array.from({ length: 29 }, () => [])], budget))).toBe(
      'too-large',
    )
  })

  test('a very long table is measured without spreading its rows into arguments', () => {
    const rows = Array.from({ length: 1_000_000 }, () => ['x'])
    const md = tableToMarkdown(rows, new TableBudget(1_000_000))
    expect(md.split('\n')).toHaveLength(1_000_001)
  })

  test('text is tidied without losing indentation', () => {
    expect(tidyText('  a   b \r\n\n\n\n    - c\t d  ')).toBe('a b\n\n    - c d')
  })

  test('sources keep a kind older clients know', () => {
    expect(sourceFieldsOf({ kind: 'deck', format: 'pptx' })).toEqual({ kind: 'note', support: 'deck' })
    expect(sourceFieldsOf({ kind: 'deck', format: 'pdf' })).toEqual({ kind: 'pdf', support: 'deck' })
    expect(sourceFieldsOf({ kind: 'document', format: 'docx' })).toEqual({ kind: 'note', support: 'document' })
  })

  test('mime types, vision formats, titles and unit images', () => {
    expect(mimeOfPath('a/b.JPG')).toBe('image/jpeg')
    expect(mimeOfPath('a/b.emf')).toBe('image/emf')
    expect(mimeOfPath('a/b')).toBe('application/octet-stream')
    expect(isVisionImage('image/png')).toBe(true)
    expect(isVisionImage('image/emf')).toBe(false)
    expect(titleFromName('Cours 3.final.pptx')).toBe('Cours 3.final')
    expect(titleFromName(undefined)).toBe('')
    const img = { id: 'a', mime: 'image/png', bytes: new Uint8Array([1]) }
    expect(unitImages({ images: new Map([['a', img]]) }, { images: [{ id: 'a' }, { id: 'gone' }] })).toEqual([img])
  })
})
