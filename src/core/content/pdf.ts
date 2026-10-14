/// <reference types="vite/client" />
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/** Local cache of extracted text, keyed by the PDF's sha256. Never part of the synced doc. */
export interface PdfTextCache {
  get(sha256: string): Promise<readonly string[] | null>
  set(sha256: string, pages: readonly string[]): Promise<void>
}

type PdfJs = typeof import('pdfjs-dist')
let pdfjsPromise: Promise<PdfJs> | null = null

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist').then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = workerUrl
    return mod
  })
  return pdfjsPromise
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Extracts the text of every page (index 0 = page 1), lazily loading pdf.js. */
export async function extractPdfText(data: Uint8Array, cache?: PdfTextCache): Promise<string[]> {
  const sha = cache ? await sha256Hex(data) : ''
  if (cache) {
    const hit = await cache.get(sha)
    if (hit) return [...hit]
  }
  const pdfjs = await loadPdfJs()
  // pdf.js transfers the buffer to its worker: hand it a copy so the caller keeps its bytes.
  // pdf.js 6 removed its eval/`new Function` font path, and with it the `isEvalSupported` option.
  const task = pdfjs.getDocument({ data: new Uint8Array(data) })
  const doc = await task.promise
  try {
    const pages: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        text += item.str
        if (item.hasEOL) text += '\n'
      }
      pages.push(text.trim())
      page.cleanup()
    }
    if (cache) await cache.set(sha, pages)
    return pages
  } finally {
    await task.destroy()
  }
}
