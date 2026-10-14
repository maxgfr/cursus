import { expect, type Page } from '@playwright/test'
import { test } from './support/own-app.ts'
import { createCourse, watchErrors } from './support/page.ts'

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
