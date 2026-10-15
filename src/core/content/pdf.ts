/// <reference types="vite/client" />
/**
 * PDF through pdf.js, loaded on first use only (pdf.js and its worker are never in the initial JS): text per
 * page, slide-export detection (pages ⇒ slides), and page rendering to an image for vision models.
 */
import { type Deck, DeckError, type DeckLimits, type DeckUnit, deckLimits, titleFromName } from './deck'

/** Local cache of extracted text, keyed by the PDF's sha256. Never part of the synced doc. */
export interface PdfTextCache {
  get(sha256: string): Promise<readonly string[] | null>
  set(sha256: string, pages: readonly string[]): Promise<void>
}

type PdfJs = typeof import('pdfjs-dist')
/** How pdf.js is obtained; the default loads it with its worker, tests inject one. */
export type PdfJsLoader = () => Promise<PdfJs>
let pdfjsPromise: Promise<PdfJs> | null = null

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
    ([mod, worker]) => {
      mod.GlobalWorkerOptions.workerSrc = worker.default
      return mod
    },
  )
  return pdfjsPromise
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface PdfPageInfo {
  /** 1-based. */
  page: number
  text: string
  /** The text set in the page's largest type, when it stands out (a slide title); else empty. */
  title: string
  /** In PDF points, rotation applied. */
  width: number
  height: number
}

export interface PdfMeta {
  title?: string
  producer?: string
  creator?: string
}

export interface RenderPdfOptions {
  /** Longest side in pixels (default 1568, what vision models use without downscaling). */
  maxDimension?: number
  mime?: 'image/jpeg' | 'image/png' | 'image/webp'
  quality?: number
  /** Where pages are drawn; the default is an OffscreenCanvas. */
  canvas?: CanvasFactory
}

export interface RenderTarget {
  /** pdf.js draws on any 2D context: a canvas element's or an OffscreenCanvas's. */
  context: CanvasRenderingContext2D
  toBlob(mime: string, quality: number): Promise<Blob>
}
export type CanvasFactory = (width: number, height: number) => RenderTarget

export interface OpenPdfOptions {
  pdfjs?: PdfJsLoader
  limits?: Partial<DeckLimits>
  signal?: AbortSignal
}

/** An open PDF: read pages and render them as needed, then `close` it. */
export interface PdfHandle {
  readonly numPages: number
  readonly meta: PdfMeta
  page(n: number): Promise<PdfPageInfo>
  render(n: number, options?: RenderPdfOptions): Promise<Blob>
  close(): Promise<void>
}

export const DEFAULT_RENDER_DIMENSION = 1568

function pdfError(cause: unknown): DeckError {
  const name = cause instanceof Error ? cause.name : ''
  const message = cause instanceof Error ? cause.message : String(cause)
  if (name === 'PasswordException') return new DeckError('encrypted', 'the PDF is password-protected')
  return new DeckError('corrupt', `cannot read the PDF: ${message}`)
}

function metaString(info: unknown, key: string): string | undefined {
  if (typeof info !== 'object' || info === null) return undefined
  const v: unknown = Reflect.get(info, key)
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

function offscreenCanvas(width: number, height: number): RenderTarget {
  if (typeof OffscreenCanvas === 'undefined') throw new DeckError('unsupported', 'page rendering needs OffscreenCanvas')
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new DeckError('unsupported', '2d canvas unavailable')
  return {
    // pdf.js only uses the drawing API both contexts share.
    context: context as unknown as CanvasRenderingContext2D,
    toBlob: (mime, quality) => canvas.convertToBlob({ type: mime, quality }),
  }
}

type ContentItem = Awaited<ReturnType<import('pdfjs-dist').PDFPageProxy['getTextContent']>>['items'][number]
type TextLike = Extract<ContentItem, { str: string }>

function isTextItem(item: ContentItem): item is TextLike {
  return 'str' in item
}

/**
 * The run(s) of text in the largest type, when that type is clearly larger than the body's (the size
 * carrying the most characters). One size only: nothing stands out, no title.
 */
function titleOf(items: readonly TextLike[]): string {
  const sized = items.filter((i) => i.str.trim() !== '' && i.height > 0)
  const chars = new Map<number, number>()
  let max = 0
  for (const i of sized) {
    chars.set(i.height, (chars.get(i.height) ?? 0) + i.str.length)
    max = Math.max(max, i.height)
  }
  let body = 0
  let most = -1
  for (const [height, n] of chars) {
    if (n > most || (n === most && height < body)) {
      body = height
      most = n
    }
  }
  if (sized.length === 0 || max < body * 1.15) return ''
  return sized
    .filter((i) => i.height >= max * 0.95)
    .map((i) => i.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

export async function openPdf(data: Uint8Array, options: OpenPdfOptions = {}): Promise<PdfHandle> {
  const limits = deckLimits(options.limits)
  if (data.length > limits.maxFileBytes) {
    throw new DeckError('too-large', `file is ${data.length} bytes, limit ${limits.maxFileBytes}`)
  }
  const { signal } = options
  signal?.throwIfAborted()
  const pdfjs = await (options.pdfjs ?? loadPdfJs)()
  signal?.throwIfAborted()
  // pdf.js transfers the buffer to its worker: hand it a copy so the caller keeps its bytes.
  // pdf.js 6 removed its eval/`new Function` font path, and with it the `isEvalSupported` option.
  const task = pdfjs.getDocument({ data: new Uint8Array(data), verbosity: pdfjs.VerbosityLevel.ERRORS })
  const abort = (): void => {
    void task.destroy()
  }
  signal?.addEventListener('abort', abort, { once: true })
  let doc: Awaited<typeof task.promise>
  let info: unknown
  try {
    doc = await task.promise
    info = (await doc.getMetadata()).info
    signal?.throwIfAborted()
  } catch (cause) {
    signal?.removeEventListener('abort', abort)
    await task.destroy()
    signal?.throwIfAborted()
    throw pdfError(cause)
  }
  const meta: PdfMeta = {}
  const title = metaString(info, 'Title')
  const producer = metaString(info, 'Producer')
  const creator = metaString(info, 'Creator')
  if (title) meta.title = title
  if (producer) meta.producer = producer
  if (creator) meta.creator = creator

  const checkPage = (n: number): void => {
    if (!Number.isInteger(n) || n < 1 || n > doc.numPages) throw new RangeError(`no page ${n}`)
    signal?.throwIfAborted()
  }
  return {
    numPages: doc.numPages,
    meta,
    async page(n) {
      checkPage(n)
      const page = await doc.getPage(n)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const content = await page.getTextContent()
        const items = content.items.filter(isTextItem)
        let text = ''
        for (const item of items) {
          text += item.str
          if (item.hasEOL) text += '\n'
        }
        return { page: n, text: text.trim(), title: titleOf(items), width: viewport.width, height: viewport.height }
      } finally {
        page.cleanup()
      }
    },
    async render(n, o = {}) {
      checkPage(n)
      const page = await doc.getPage(n)
      try {
        const base = page.getViewport({ scale: 1 })
        const scale = (o.maxDimension ?? DEFAULT_RENDER_DIMENSION) / Math.max(base.width, base.height)
        const viewport = page.getViewport({ scale })
        const w = Math.max(1, Math.round(viewport.width))
        const h = Math.max(1, Math.round(viewport.height))
        const target = (o.canvas ?? offscreenCanvas)(w, h)
        await page.render({ canvas: null, canvasContext: target.context, viewport }).promise
        return await target.toBlob(o.mime ?? 'image/jpeg', o.quality ?? 0.85)
      } finally {
        page.cleanup()
      }
    },
    async close() {
      signal?.removeEventListener('abort', abort)
      await task.destroy()
    },
  }
}

/** Extracts the text of every page (index 0 = page 1), lazily loading pdf.js. */
export async function extractPdfText(
  data: Uint8Array,
  cache?: PdfTextCache,
  options: OpenPdfOptions = {},
): Promise<string[]> {
  const sha = cache ? await sha256Hex(data) : ''
  if (cache) {
    const hit = await cache.get(sha)
    if (hit) return [...hit]
  }
  const pdf = await openPdf(data, options)
  try {
    const pages: string[] = []
    for (let n = 1; n <= pdf.numPages; n++) pages.push((await pdf.page(n)).text)
    if (cache) await cache.set(sha, pages)
    return pages
  } finally {
    await pdf.close()
  }
}

const SLIDE_TOOLS = /powerpoint|keynote|google slides|impress|beamer|prezi|canva/i
/** 4:3 is 1.33, 16:10 1.6, 16:9 1.78. */
const SLIDE_RATIO = { min: 1.25, max: 1.9 }
const SLIDE_MAX_CHARS = 1500

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * A slide export: made by a presentation tool with mostly landscape pages, or, whatever the tool, nearly all
 * pages at a screen ratio with little text on each.
 */
export function looksLikeSlides(
  pages: readonly Pick<PdfPageInfo, 'width' | 'height' | 'text'>[],
  meta: PdfMeta,
): boolean {
  if (pages.length === 0) return false
  const screen = pages.filter((p) => {
    const r = p.width / p.height
    return r >= SLIDE_RATIO.min && r <= SLIDE_RATIO.max
  }).length
  const share = screen / pages.length
  const tool = SLIDE_TOOLS.test(`${meta.producer ?? ''} ${meta.creator ?? ''}`)
  if (tool && share >= 0.5) return true
  return share >= 0.8 && median(pages.map((p) => p.text.length)) <= SLIDE_MAX_CHARS
}

export interface ReadPdfDeckOptions extends OpenPdfOptions {
  name?: string
}

/** A PDF as a deck of slides (slide export) or a document of pages; pages render on demand (`PdfHandle.render`). */
export async function readPdfDeck(data: Uint8Array, options: ReadPdfDeckOptions = {}): Promise<Deck> {
  const limits = deckLimits(options.limits)
  const pdf = await openPdf(data, options)
  try {
    const warnings: string[] = []
    let count = pdf.numPages
    if (count > limits.maxUnits) {
      warnings.push(`unit-limit:${count}`)
      count = limits.maxUnits
    }
    const pages: PdfPageInfo[] = []
    for (let n = 1; n <= count; n++) pages.push(await pdf.page(n))
    const slides = looksLikeSlides(pages, pdf.meta)
    const units: DeckUnit[] = pages.map((p) => {
      const firstLine = p.text.split('\n')[0]?.trim().slice(0, 120) ?? ''
      const title = p.title || (slides ? firstLine : '')
      const text = title !== '' && p.text.startsWith(title) ? p.text.slice(title.length).trim() : p.text
      return {
        index: p.page,
        kind: slides ? 'slide' : 'page',
        label: String(p.page),
        title,
        text,
        images: [],
        page: p.page,
      }
    })
    const title = pdf.meta.title || titleFromName(options.name) || units.find((u) => u.title)?.title || ''
    return { kind: slides ? 'deck' : 'document', format: 'pdf', title, units, images: new Map(), warnings }
  } finally {
    await pdf.close()
  }
}

/** Renders one page to an image (opens and closes the PDF; use `openPdf` to render many). */
export async function renderPdfPage(
  data: Uint8Array,
  page: number,
  options: RenderPdfOptions & OpenPdfOptions = {},
): Promise<Blob> {
  const pdf = await openPdf(data, options)
  try {
    return await pdf.render(page, options)
  } finally {
    await pdf.close()
  }
}
