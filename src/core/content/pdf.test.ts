import { describe, expect, test } from 'bun:test'
import { pdf, slidesPdf } from '../../../tests/fixtures/content/build'
import { DeckError, type DeckErrorKind, importDeck } from './deck'
import {
  extractPdfText,
  looksLikeSlides,
  openPdf,
  type PdfJsLoader,
  type PdfTextCache,
  readPdfDeck,
  renderPdfPage,
} from './pdf'

/** pdf.js's Node build, its worker run in-process: no browser needed. */
const pdfjs: PdfJsLoader = async () => {
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  mod.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  return mod
}

async function kindOf(p: Promise<unknown>): Promise<DeckErrorKind | string> {
  try {
    await p
  } catch (e) {
    return e instanceof DeckError ? e.kind : `not a DeckError: ${String(e)}`
  }
  return 'no error'
}

const A4 = { width: 595, height: 842 }
const prose = 'The membrane potential results from unequal ion distributions across the membrane. '.repeat(30)

describe('pdf', () => {
  test('a slide export becomes a deck of slides with their titles', async () => {
    const deck = await importDeck(slidesPdf(), { name: 'slides.pdf', pdfjs })
    expect(deck.kind).toBe('deck')
    expect(deck.format).toBe('pdf')
    expect(deck.title).toBe('Cell Biology slides')
    expect(deck.units.map((u) => [u.index, u.kind, u.label, u.title, u.text, u.page])).toEqual([
      [1, 'slide', '1', 'Cell Biology 101', 'Membranes and transport', 1],
      [2, 'slide', '2', 'Osmosis', 'Water crosses semi-permeable membranes', 2],
      [3, 'slide', '3', 'Active transport', 'Pumps use ATP', 3],
    ])
    expect(deck.images.size).toBe(0)
  })

  test('a text-heavy portrait PDF is a document of pages', async () => {
    const data = pdf([{ lines: [prose.slice(0, 90)] }, { lines: ['Second page'] }], A4)
    const deck = await readPdfDeck(data, { pdfjs, name: 'Handout.pdf' })
    expect(deck.kind).toBe('document')
    expect(deck.title).toBe('Handout')
    expect(deck.units.map((u) => [u.kind, u.label, u.title])).toEqual([
      ['page', '1', ''],
      ['page', '2', ''],
    ])
    expect(deck.units[1]?.text).toBe('Second page')
  })

  test('slide detection: tool, ratio and text density', () => {
    const slide = { width: 960, height: 540, text: 'short' }
    const page = { width: 595, height: 842, text: 'short' }
    expect(looksLikeSlides([], {})).toBe(false)
    expect(looksLikeSlides([slide, slide, slide], {})).toBe(true)
    expect(looksLikeSlides([page, page], {})).toBe(false)
    expect(looksLikeSlides([{ ...slide, text: prose }], {})).toBe(false)
    expect(looksLikeSlides([{ ...slide, text: prose }], { producer: 'Keynote' })).toBe(true)
    expect(looksLikeSlides([slide, page], { creator: 'LaTeX with Beamer class' })).toBe(true)
    expect(looksLikeSlides([slide, page, page], { creator: 'PowerPoint' })).toBe(false)
    // 4:3 slides count too; a square page does not.
    expect(looksLikeSlides([{ width: 1024, height: 768, text: '' }], {})).toBe(true)
    expect(looksLikeSlides([{ width: 500, height: 500, text: '' }], {})).toBe(false)
  })

  test('a password-protected PDF is reported as encrypted, garbage as corrupt', async () => {
    const locked = pdf([{ lines: ['secret'] }], { ...A4, encrypted: true })
    expect(await kindOf(readPdfDeck(locked, { pdfjs }))).toBe('encrypted')
    expect(await kindOf(readPdfDeck(new TextEncoder().encode('%PDF-1.4\ngarbage'), { pdfjs }))).toBe('corrupt')
  })

  test('size and page limits', async () => {
    expect(await kindOf(readPdfDeck(slidesPdf(), { pdfjs, limits: { maxFileBytes: 10 } }))).toBe('too-large')
    const deck = await readPdfDeck(slidesPdf(), { pdfjs, limits: { maxUnits: 2 } })
    expect(deck.units).toHaveLength(2)
    expect(deck.warnings).toEqual(['unit-limit:3'])
  })

  test('an aborted signal stops before or while opening', async () => {
    const before = new AbortController()
    before.abort()
    await expect(readPdfDeck(slidesPdf(), { pdfjs, signal: before.signal })).rejects.toThrow()
    const during = new AbortController()
    const p = openPdf(slidesPdf(), {
      pdfjs: async () => {
        const mod = await pdfjs()
        during.abort()
        return mod
      },
      signal: during.signal,
    })
    await expect(p).rejects.toThrow()
  })

  test('pages are range-checked; rendering needs a canvas', async () => {
    const handle = await openPdf(slidesPdf(), { pdfjs })
    try {
      expect(handle.numPages).toBe(3)
      expect(handle.meta.producer).toBe('Microsoft PowerPoint for Mac')
      await expect(handle.page(0)).rejects.toThrow(RangeError)
      await expect(handle.page(4)).rejects.toThrow(RangeError)
      expect(await handle.page(2)).toEqual({
        page: 2,
        text: 'Osmosis\nWater crosses semi-permeable membranes',
        title: 'Osmosis',
        width: 720,
        height: 405,
      })
    } finally {
      await handle.close()
    }
    // bun has no OffscreenCanvas: the default target fails with a typed error.
    expect(await kindOf(renderPdfPage(slidesPdf(), 1, { pdfjs }))).toBe('unsupported')
  })

  test('rendering draws on the target the caller provides, scaled to the longest side', async () => {
    const sizes: [number, number][] = []
    const out = await renderPdfPage(slidesPdf(), 2, {
      pdfjs,
      maxDimension: 360,
      mime: 'image/png',
      canvas: (w, h) => {
        sizes.push([w, h])
        throw new DeckError('unsupported', 'no canvas in this test')
      },
    }).catch((e: unknown) => e)
    expect(out).toBeInstanceOf(DeckError)
    expect(sizes).toEqual([[360, 203]])
  })

  test('extractPdfText reads every page and uses the cache', async () => {
    const store = new Map<string, readonly string[]>()
    const cache: PdfTextCache = {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => {
        store.set(k, v)
      },
    }
    const first = await extractPdfText(slidesPdf(), cache, { pdfjs })
    expect(first).toEqual([
      'Cell Biology 101\nMembranes and transport',
      'Osmosis\nWater crosses semi-permeable membranes',
      'Active transport\nPumps use ATP',
    ])
    expect(store.size).toBe(1)
    const failing: PdfJsLoader = () => Promise.reject(new Error('must not load pdf.js on a cache hit'))
    expect(await extractPdfText(slidesPdf(), cache, { pdfjs: failing })).toEqual(first)
    expect(await extractPdfText(slidesPdf(), undefined, { pdfjs })).toEqual(first)
  })
})
