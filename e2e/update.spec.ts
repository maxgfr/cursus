import { expect, type Page } from '@playwright/test'
import { test } from './support/own-app.ts'
import { createCourse, go, typeInto, watchErrors } from './support/page.ts'

async function waitForController(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
}

test('a new version applied while typing loses no keystroke', async ({ page, ownApp }) => {
  // Playwright cannot route a service worker's script update check (context.route sees only the first
  // registration fetch), so a new version is published by rewriting sw.js in this test's own copy of the app.
  test.setTimeout(90_000)
  const errors = watchErrors(page)
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await waitForController(page)

  await createCourse(page, 'Pharmacology')
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: 'Write a note' }).click()
  const editor = page.getByRole('textbox', { name: 'Source' })
  await editor.click()
  await page.keyboard.type('Beta blockers slow ', { delay: 20 })

  // A new version is published and found on return to the foreground, mid-sentence.
  await ownApp.publishNewVersion()
  const toast = page.getByRole('status').filter({ hasText: 'A new version of Cursus is ready.' })
  const words = ['the ', 'heart ']
  // Back to the foreground (repeated: one check may land before the worker sees the new bytes), typing between.
  await expect(async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const word = words.shift()
    if (word) await page.keyboard.type(word, { delay: 20 })
    await expect(toast).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
  for (const word of words) await page.keyboard.type(word, { delay: 20 })
  // Still typing when the toast arrives, then the update is applied straight away.
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type('and lower blood pressure.')
  await Promise.all([page.waitForEvent('load'), toast.getByRole('button', { name: 'Update' }).click()])

  await expect(page.getByRole('heading', { level: 1, name: 'Untitled note' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Source' })).toHaveText(
    'Beta blockers slow the heart and lower blood pressure.',
  )
  expect(errors).toEqual([])
})

/** Edits captured on this device and not yet sealed into a segment (sealing waits for 10 s of quiet). */
function unsealed(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('cursus-v1')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const count = db.transaction('pending').objectStore('pending').count()
          count.onsuccess = () => {
            db.close()
            resolve(count.result)
          }
          count.onerror = () => {
            db.close()
            reject(count.error)
          }
        }
      }),
  )
}

/** Back to the foreground: the app asks for a new version (repeated: one check may land before the new bytes). */
async function foreground(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

test('Settings shows this build, says it is up to date, finds a new version and updates into it, every edit kept', async ({
  page,
  ownApp,
}) => {
  test.setTimeout(90_000)
  const errors = watchErrors(page)
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await waitForController(page)
  await createCourse(page, 'Histology')

  // Version and updates are with the diagnostics.
  await go(page, '#/settings/diagnostic', 'Diagnostics')
  const version = page.getByTestId('app-version')
  await expect(version).toHaveText(/^Cursus \d+\.\d+\.\d+\S* · ([0-9a-f]{7,40}|dev) · built .*\d{4}$/)
  expect(await version.textContent()).not.toContain('fedcba9')
  await expect(page.getByText('Sync data format: version 2 (reads 1 and 2)')).toBeVisible()
  const status = page.getByTestId('update-status')
  const check = page.getByRole('button', { name: 'Check for updates' })

  // Nothing newer yet.
  await check.click()
  await expect(status).toHaveText(/^Cursus is up to date\. Last checked at \d{1,2}:\d{2}.*\.$/)

  // A new build is published: the check downloads it and offers it.
  await ownApp.publishNewVersion({ commit: 'fedcba9' })
  await check.click()
  await expect(status).toHaveText('A new version is ready. Your edits are saved before it opens.')
  const updateNow = page.getByRole('button', { name: 'Update now' })
  // An edit made just before updating is still unsealed when Update now is pressed.
  await go(page, '#/settings/general', 'General')
  await page.getByRole('radio', { name: 'Dark' }).check()
  await go(page, '#/settings/diagnostic', 'Diagnostics')
  await expect.poll(() => unsealed(page)).toBeGreaterThan(0)
  await Promise.all([page.waitForEvent('load'), updateNow.click()])

  // Reloaded into the new build, with every edit.
  await expect(page.getByRole('heading', { level: 1, name: 'Diagnostics' })).toBeVisible()
  await expect(version).toHaveText(/^Cursus \d+\.\d+\.\d+\S* · fedcba9 · built /)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByText('A new version of Cursus is ready.')).toHaveCount(0)
  await check.click()
  await expect(status).toHaveText(/^Cursus is up to date\./)
  await go(page, '#/courses', 'Courses')
  await expect(page.getByRole('main').getByRole('link', { name: /Histology/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('offline, Settings explains why it cannot check; back online, it checks', async ({ page, context }) => {
  await page.goto('./#/settings/diagnostic')
  await expect(page.getByRole('heading', { level: 1, name: 'Diagnostics' })).toBeVisible()
  await waitForController(page)
  const status = page.getByTestId('update-status')
  const check = page.getByRole('button', { name: 'Check for updates' })
  await expect(check).toBeEnabled()
  await context.setOffline(true)
  await expect(status).toHaveText('You’re offline. Connect to the internet to check for updates.')
  await expect(check).toBeDisabled()
  await context.setOffline(false)
  await expect(check).toBeEnabled()
  await check.click()
  await expect(status).toHaveText(/^Cursus is up to date\./)
})

test('without a service worker, Settings explains it and Reload keeps every edit', async ({ browser, ownApp }) => {
  const context = await browser.newContext({ serviceWorkers: 'block', baseURL: ownApp.url })
  const page = await context.newPage()
  await page.goto('./#/settings/diagnostic')
  await expect(page.getByRole('heading', { level: 1, name: 'Diagnostics' })).toBeVisible()
  await expect(page.getByTestId('update-status')).toHaveText(
    'Updates can’t be checked in this window (development or private browsing). Reload to get the latest version.',
  )
  await expect(page.getByRole('button', { name: 'Check for updates' })).toHaveCount(0)
  await go(page, '#/settings/general', 'General')
  await page.getByRole('radio', { name: 'Dark' }).check()
  await go(page, '#/settings/diagnostic', 'Diagnostics')
  await expect.poll(() => unsealed(page)).toBeGreaterThan(0)
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload' }).click()])
  await expect(page.getByRole('heading', { level: 1, name: 'Diagnostics' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await context.close()
})

test('an update applied mid-draft in the card editor brings the draft back after the reload', async ({
  page,
  ownApp,
}) => {
  test.setTimeout(90_000)
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await waitForController(page)
  await createCourse(page, 'Botany')
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  await expect(page.getByRole('textbox', { name: 'Front' })).toBeVisible()

  await ownApp.publishNewVersion()
  const toast = page.getByRole('status').filter({ hasText: 'A new version of Cursus is ready.' })
  await expect(async () => {
    await foreground(page)
    await expect(toast).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
  // Applied the instant typing stops: the draft's own copy (written a moment after typing) is not there yet.
  await typeInto(page, 'Front', 'Xylem carries?')
  await Promise.all([page.waitForEvent('load'), toast.getByRole('button', { name: 'Update' }).click()])

  await expect(page.getByText('Unsaved draft restored.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Front' })).toContainText('Xylem carries?')
})
