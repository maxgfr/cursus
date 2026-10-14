import { readFile } from 'node:fs/promises'
import { expect, type Page, test } from '@playwright/test'
import { test as ownAppTest } from './support/own-app.ts'

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

// Publishes its new version on its own copy of the app: the shared dist/ is never rewritten.
ownAppTest('a new version is offered on return to the foreground and applied', async ({ page, ownApp }) => {
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
  await ownApp.publishNewVersion()
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
})

test('a PWA chunk that fails to load is recorded, never thrown, and registration is retried on return', async ({
  page,
  browserName,
}) => {
  const thrown: string[] = []
  page.on('pageerror', (e) => thrown.push(e.message))
  const chunk = /\/assets\/virtual_pwa-register-[^/]+\.js$/
  await page.route(chunk, (route) => route.abort())
  const failed = page.waitForEvent('requestfailed', (r) => chunk.test(r.url()))
  await openToday(page)
  await failed
  const registered = () => page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r !== undefined))
  /** The diagnostic report's recorded failures, rebuilt by opening the screen afresh (in-app, no reload). */
  const recorded = async () => {
    await page.evaluate(() => {
      location.hash = '#/'
    })
    await expect(page.getByRole('heading', { level: 1, name: /Today/ })).toBeVisible()
    await page.evaluate(() => {
      location.hash = '#/settings/diagnostic'
    })
    await expect(page.locator('pre')).toContainText('"errors"')
    return ((await page.locator('pre').textContent()) ?? '').match(/pwa\.start TypeError/g)?.length ?? 0
  }
  // The app stays usable; the failure is in the diagnostic report.
  expect(await recorded()).toBe(1)
  expect(await registered()).toBe(false)
  // Back to the foreground with the network healed: registration is tried once more.
  await page.unroute(chunk)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
  })
  if (browserName === 'webkit') {
    // WebKit keeps a failed module import failed for the life of the document: the retry is recorded, and the
    // worker registers on the next launch.
    await expect.poll(recorded).toBe(2)
  } else {
    await expect.poll(registered).toBe(true)
    expect(await recorded()).toBe(1)
  }
  expect(thrown).toEqual([])
})

test('storage persistence is requested', async ({ page }) => {
  // Observed on the prototype: WebKit hands out a fresh `navigator.storage` wrapper after init scripts, so a
  // property set on the instance here is gone by the time the app asks (the request went unobserved).
  await page.addInitScript(() => {
    const w = window as Window & { __persistAsked?: boolean }
    const orig = StorageManager.prototype.persist
    StorageManager.prototype.persist = function (this: StorageManager) {
      w.__persistAsked = true
      return orig.call(this)
    }
  })
  await openToday(page)
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __persistAsked?: boolean }).__persistAsked === true))
    .toBe(true)
})
