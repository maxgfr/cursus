import { expect, type Page, test } from '@playwright/test'
import { AwsClient } from 'aws4fetch'
import { createCourse, go, typeInto, watchErrors } from './support/page.ts'

// Service workers on: after the first load, the precache serves the whole app with no network at all.

const S3 = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'cursus',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'cursus-secret',
  region: 'us-east-1',
}

async function newBucket(): Promise<string> {
  const admin = new AwsClient({ ...S3, service: 's3' })
  const bucket = `offline-${crypto.randomUUID()}`
  const res = await admin.fetch(`${S3.endpoint}/${bucket}`, { method: 'PUT' })
  expect(res.status).toBe(200)
  return bucket
}

async function waitForController(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  // The first visit is not controlled until the next navigation.
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
}

const chip = (page: Page) => page.locator('[data-sync]').first()

test('after the first load the app works fully offline, and edits are saved on the device', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  const errors = watchErrors(page)
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await waitForController(page)

  // A destination, so the chip has something to be truthful about.
  const bucket = await newBucket()
  await go(page, '#/settings/sync', 'Sync & backup')
  // S3 sits under the "Advanced" disclosure.
  await page.locator('summary', { hasText: 'Advanced' }).click()
  await page.getByRole('button', { name: 'S3-compatible storage' }).click()
  const dialog = page.getByRole('dialog', { name: 'S3-compatible storage' })
  await dialog.getByLabel('Endpoint URL').fill(S3.endpoint)
  await dialog.getByLabel('Bucket').fill(bucket)
  await dialog.getByLabel('Region').fill(S3.region)
  await dialog.getByLabel('Folder prefix').fill('cursus')
  await dialog.getByLabel('Access key ID').fill(S3.accessKeyId)
  await dialog.getByLabel('Secret access key').fill(S3.secretAccessKey)
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByText('Connection works.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeHidden()

  // Cut off, then a cold start: the shell, every lazy screen and the catalog come from the precache.
  await go(page, '#/', 'Today')
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await expect(chip(page)).toHaveAttribute('data-sync', 'offline')
  await expect(chip(page)).toContainText('Offline · saved on this device')

  await go(page, '#/', 'Today')
  await createCourse(page, 'Offline anatomy')
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  await typeInto(page, 'Front', 'Longest bone?')
  await typeInto(page, 'Back', 'The femur')
  // The editor holds a draft: the card exists only once saved (offline, on this device).
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('main').getByRole('link', { name: /Longest bone\?/ })).toBeVisible()
  for (const [hash, heading] of [
    ['#/search', 'Search'],
    ['#/stats', 'Statistics'],
    ['#/understand', 'New study sheet'],
    ['#/settings', 'Settings'],
    ['#/settings/data', 'Import & export'],
    ['#/review', 'Review'],
  ] as const)
    await go(page, hash, heading)

  // "Saved on this device" is true: a cold start, still offline, shows the edit.
  await go(page, '#/', 'Today')
  await expect(page.locator('[data-sync="unsaved"]')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await expect(chip(page)).toHaveAttribute('data-sync', 'offline')
  await expect(page.getByRole('main').getByRole('button', { name: /^Offline anatomy/ })).toContainText('1 new')
  await go(page, '#/courses', 'Courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Offline anatomy/ })
    .click()
  await expect(page.getByRole('main').getByRole('link', { name: /Longest bone\?/ })).toBeVisible()

  // Back online, the chip stops saying offline and the change goes out.
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await go(page, '#/settings/sync', 'Sync & backup')
  await expect(async () => {
    await page.getByRole('button', { name: 'Sync now' }).click()
    await expect(chip(page)).toHaveAttribute('data-sync', 'protected', { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  // Requests that failed while offline are the only errors allowed.
  expect(
    errors.filter(
      (e) =>
        !/Failed to load resource|Load failed|network connection|ERR_INTERNET_DISCONNECTED|due to access control checks/i.test(
          e,
        ),
    ),
  ).toEqual([])
})
