import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'

const SW = join(import.meta.dirname, '..', 'dist', 'sw.js')

// One test rewrites dist/sw.js to publish a new version: keep the others from installing it meanwhile.
test.describe.configure({ mode: 'serial' })

/** Collects console errors (CSP violations land here) and uncaught exceptions. */
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

async function openToday(page: Page) {
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: /Today|Heute|Aujourd/ })).toBeVisible()
}

async function waitForController(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  // The first visit is not controlled until the next navigation.
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
}

test('the manifest is installable and relative to the base', async ({ page, request }) => {
  await openToday(page)
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(href).toBeTruthy()
  const manifestUrl = new URL(href ?? '', page.url()).toString()
  const res = await request.get(manifestUrl)
  expect(res.ok()).toBe(true)
  const m = await res.json()
  expect(m.id).toBe('./')
  expect(m.scope).toBe('./')
  expect(m.start_url).toBe('./')
  expect(m.display_override).toContain('standalone')
  expect(m.shortcuts.length).toBeGreaterThan(0)
  expect(m.file_handlers[0].accept['application/x-cursus']).toContain('.cursus')
  const sizes = m.icons.map((i: { sizes: string }) => i.sizes)
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']))
  expect(m.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true)
  for (const icon of m.icons) {
    expect((await request.get(new URL(icon.src, manifestUrl).toString())).ok()).toBe(true)
  }
  // iOS: touch icon and splash screens.
  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
  expect((await request.get(new URL(touch ?? '', page.url()).toString())).ok()).toBe(true)
  expect(await page.locator('link[rel="apple-touch-startup-image"]').count()).toBeGreaterThan(10)
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(csp).toContain("default-src 'self'")
  expect(csp).toContain("object-src 'none'")
  // Loopback endpoints (local MinIO, Ollama, LM Studio on the Mac) are reachable over plain http.
  expect(csp).toMatch(/connect-src [^;]*http:\/\/localhost:\*/)
  expect(csp).toMatch(/connect-src [^;]*http:\/\/127\.0\.0\.1:\*/)
  expect(csp).not.toContain("'unsafe-inline' 'wasm-unsafe-eval'")
})

test('a .cursus file opened with the app is merged into the library, and the result is told', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000)
  // One device makes a backup…
  await page.goto('./#/courses')
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill('Embryology')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Embryology' })).toBeVisible()
  await page.goto('./#/settings/data')
  const saved = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export backup' }).click()
  const bytes = await readFile(await (await saved).path())

  // …another opens it from the Finder: the OS launches the app with the file (window.launchQueue).
  const other = await browser.newContext({ serviceWorkers: 'block' })
  await other.addInitScript((b64: string) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const file = new File([data], 'backup.cursus', { type: 'application/x-cursus' })
    Object.defineProperty(window, 'launchQueue', {
      value: {
        setConsumer(consumer: (p: { files: { getFile(): Promise<File> }[] }) => void) {
          consumer({ files: [{ getFile: async () => file }] })
        },
      },
    })
  }, bytes.toString('base64'))
  const page2 = await other.newPage()
  await openToday(page2)
  await expect(page2.getByRole('status').filter({ hasText: /Backup opened: \d+ new items? merged/ })).toBeVisible({
    timeout: 20_000,
  })
  await page2.goto('./#/courses')
  await expect(page2.getByRole('main').getByRole('link', { name: /Embryology/ })).toBeVisible()
  await other.close()
})

test('the app works offline from the precache, without CSP violations', async ({ page, context }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await waitForController(page)
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys()
    const urls: string[] = []
    for (const k of keys) for (const r of await (await caches.open(k)).keys()) urls.push(r.url)
    return urls
  })
  expect(cached.some((u) => /\/index\.html(\?|$)/.test(u))).toBe(true)
  expect(cached.some((u) => /KaTeX_Main-Regular.*\.woff2$/.test(u))).toBe(true)
  expect(cached.some((u) => u.endsWith('.bcmap'))).toBe(true)
  expect(cached.some((u) => /apple-splash/.test(u))).toBe(false)
  await context.setOffline(true)
  await openToday(page)
  await context.setOffline(false)
  expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([])
})

test('a new version is offered on return to the foreground and applied', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as Window & { __updateChecks?: number }
    w.__updateChecks = 0
    const orig = ServiceWorkerRegistration.prototype.update
    ServiceWorkerRegistration.prototype.update = function (this: ServiceWorkerRegistration) {
      w.__updateChecks = (w.__updateChecks ?? 0) + 1
      return orig.call(this)
    }
  })
  await openToday(page)
  await waitForController(page)
  // Publish a "new version": same worker code, different bytes (restored afterwards; this file runs serially).
  const original = await readFile(SW, 'utf8')
  await writeFile(SW, `${original}\n// next version\n`)
  try {
    // Back to the foreground (repeated: the registration may still be settling after the reload).
    await expect
      .poll(() =>
        page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
          document.dispatchEvent(new Event('visibilitychange'))
          return (window as Window & { __updateChecks?: number }).__updateChecks ?? 0
        }),
      )
      .toBeGreaterThan(0)
    const toast = page.getByRole('status').filter({ hasText: 'A new version of Cursus is ready.' })
    await expect(toast).toBeVisible()
    await Promise.all([page.waitForEvent('load'), toast.getByRole('button', { name: 'Update' }).click()])
    await expect(page.getByRole('heading', { level: 1, name: /Today/ })).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
    await expect(page.getByText('A new version of Cursus is ready.')).toHaveCount(0)
  } finally {
    await writeFile(SW, original)
  }
})

test('storage persistence is requested', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as Window & { __persistAsked?: boolean }
    const orig = navigator.storage.persist.bind(navigator.storage)
    navigator.storage.persist = () => {
      w.__persistAsked = true
      return orig()
    }
  })
  await openToday(page)
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __persistAsked?: boolean }).__persistAsked === true))
    .toBe(true)
})
