import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'

// The content modules need a real DOM (DOMPurify, canvas, pdf.js worker). Instead of shipping a
// test page in the app, this spec bundles a throwaway harness with Vite into a temp dir and serves
// it through Playwright routing under the preview server's origin.
const ROOT = resolve(import.meta.dirname, '..')
const FIXTURES = join(import.meta.dirname, 'fixtures')
const HARNESS_BASE = '/cursus/__content-harness__/'
const ENTRY_ID = 'virtual:content-harness'
const ENTRY_CODE = `
import { renderMarkdown } from '${ROOT}/src/core/content/markdown.ts'
import { extractPdfText } from '${ROOT}/src/core/content/pdf.ts'
import { prepareImage, ImageError } from '${ROOT}/src/core/content/image.ts'
window.harness = { renderMarkdown, extractPdfText, prepareImage, ImageError }
`
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
}

let outDir = ''
let entryFile = ''

test.use({ serviceWorkers: 'block' })

test.beforeAll(async () => {
  test.setTimeout(120_000)
  const { build } = await import('vite')
  outDir = await mkdtemp(join(tmpdir(), 'cursus-content-'))
  const result = await build({
    configFile: false,
    root: ROOT,
    base: HARNESS_BASE,
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true, target: 'es2022', minify: false, rollupOptions: { input: ENTRY_ID } },
    plugins: [
      {
        name: 'content-harness',
        resolveId: (id) => (id === ENTRY_ID ? `\0${ENTRY_ID}` : null),
        load: (id) => (id === `\0${ENTRY_ID}` ? ENTRY_CODE : null),
      },
    ],
  })
  for (const output of [result].flat()) {
    if (!('output' in output)) continue
    for (const file of output.output) if (file.type === 'chunk' && file.isEntry) entryFile = file.fileName
  }
  expect(entryFile).not.toBe('')
})

test.afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true })
})

async function openHarness(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith(HARNESS_BASE),
    async (route) => {
      const path = new URL(route.request().url()).pathname.slice(HARNESS_BASE.length)
      if (path === '' || path === 'index.html') {
        const html = `<!doctype html><meta charset="utf-8"><title>harness</title><script type="module" src="${HARNESS_BASE}${entryFile}"></script>`
        return route.fulfill({ status: 200, contentType: 'text/html', body: html })
      }
      try {
        const body = await readFile(join(outDir, path))
        return route.fulfill({ status: 200, contentType: MIME[extname(path)] ?? 'application/octet-stream', body })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return route.fulfill({ status: 404, body: 'not found' })
      }
    },
  )
  await page.goto(HARNESS_BASE)
  await page.waitForFunction(() => 'harness' in window)
}

declare global {
  interface Window {
    harness: {
      renderMarkdown: typeof import('../src/core/content/markdown.ts').renderMarkdown
      extractPdfText: typeof import('../src/core/content/pdf.ts').extractPdfText
      prepareImage: typeof import('../src/core/content/image.ts').prepareImage
      ImageError: typeof import('../src/core/content/image.ts').ImageError
    }
  }
}

test.beforeEach(async ({ page }) => {
  await openHarness(page)
})

test('markdown strips XSS payloads', async ({ page }) => {
  const result = await page.evaluate(() => {
    ;(window as Window & { pwned?: number }).pwned = 0
    const md = [
      '<script>window.pwned = 1</script>',
      '<img src="x" onerror="window.pwned = 2">',
      '[click](javascript:window.pwned=3)',
      '<a href="javascript:alert(1)">a</a>',
      '<iframe src="https://example.com"></iframe>',
      '$\\href{javascript:alert(1)}{x}$',
    ].join('\n\n')
    const html = window.harness.renderMarkdown(md)
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.append(host)
    const badAttrs = [...host.querySelectorAll('*')].flatMap((el) =>
      [...el.attributes]
        .filter((a) => a.name.startsWith('on') || /^\s*javascript:/i.test(a.value))
        .map((a) => `${el.tagName}[${a.name}]`),
    )
    return { html, badAttrs, pwned: (window as Window & { pwned?: number }).pwned }
  })
  await page.waitForTimeout(200)
  expect(result.html).not.toMatch(/<script/i)
  expect(result.html).not.toMatch(/onerror/i)
  expect(result.html).not.toMatch(/href="javascript:/i)
  expect(result.badAttrs).toEqual([])
  expect(result.html).not.toMatch(/<iframe/i)
  expect(result.pwned).toBe(0)
  expect(await page.evaluate(() => (window as Window & { pwned?: number }).pwned)).toBe(0)
})

test('markdown renders inline and block maths with KaTeX', async ({ page }) => {
  const html = await page.evaluate(() =>
    window.harness.renderMarkdown('Energy $E = mc^2$ costs \\$5.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n**bold**'),
  )
  expect(html).toContain('class="katex"')
  expect(html).toContain('katex-display')
  expect(html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>E</mi><mo>=</mo>')
  expect(html).toContain('\\int_0^1 x\\,dx')
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toContain('$5.')
})

test('markdown keeps audio and maps cursus-blob refs through the resolver', async ({ page }) => {
  const sha = 'a'.repeat(64)
  const html = await page.evaluate((h) => {
    const md = `![pic](cursus-blob:${h})\n\n<audio controls src="cursus-blob:${h}"></audio>\n\n![gone](cursus-blob:${'b'.repeat(64)})`
    return window.harness.renderMarkdown(md, { resolveBlob: (s) => (s === h ? 'blob:http://localhost/1234' : null) })
  }, sha)
  expect(html).toContain('<img src="blob:http://localhost/1234" alt="pic">')
  expect(html).toMatch(
    /<audio[^>]*controls[^>]*src="blob:http:\/\/localhost\/1234"|<audio[^>]*src="blob:http:\/\/localhost\/1234"[^>]*controls/,
  )
  expect(html).not.toContain('cursus-blob:')
})

test('pdf text is extracted per page and cached', async ({ page }) => {
  const bytes = [...(await readFile(join(FIXTURES, 'sample.pdf')))]
  const result = await page.evaluate(async (b) => {
    const store = new Map<string, readonly string[]>()
    const cache = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: readonly string[]) => {
        store.set(k, v)
      },
    }
    const first = await window.harness.extractPdfText(new Uint8Array(b), cache)
    const keys = [...store.keys()]
    store.set(keys[0] ?? '', ['from cache'])
    const second = await window.harness.extractPdfText(new Uint8Array(b), cache)
    return { first, keys, second }
  }, bytes)
  expect(result.first).toEqual(['Cursus fixture page one', 'Second page mitochondria'])
  expect(result.keys).toHaveLength(1)
  expect(result.keys[0]).toMatch(/^[0-9a-f]{64}$/)
  expect(result.second).toEqual(['from cache'])
})

test('images are downscaled to 2048px and capped in size', async ({ page }) => {
  const bytes = [...(await readFile(join(FIXTURES, 'large.png')))]
  const result = await page.evaluate(async (b) => {
    const file = new File([new Uint8Array(b)], 'large.png', { type: 'image/png' })
    const out = await window.harness.prepareImage(file)
    const bmp = await createImageBitmap(out.blob)
    const small = await window.harness.prepareImage(out.blob, { maxDimension: 4096 })
    let capped = ''
    try {
      await window.harness.prepareImage(file, { maxInputBytes: 100 })
    } catch (e) {
      capped = e instanceof window.harness.ImageError ? e.kind : String(e)
    }
    let unsupported = ''
    try {
      await window.harness.prepareImage(new Blob(['x'], { type: 'image/svg+xml' }))
    } catch (e) {
      unsupported = e instanceof window.harness.ImageError ? e.kind : String(e)
    }
    return {
      w: out.width,
      h: out.height,
      mime: out.mime,
      bw: bmp.width,
      bh: bmp.height,
      passthrough: small.blob === out.blob,
      capped,
      unsupported,
    }
  }, bytes)
  expect(result).toEqual({
    w: 2048,
    h: 1024,
    mime: 'image/png',
    bw: 2048,
    bh: 1024,
    passthrough: true,
    capped: 'too-large',
    unsupported: 'unsupported',
  })
})
