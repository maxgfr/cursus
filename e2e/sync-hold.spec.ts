import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test'
import { AwsClient } from 'aws4fetch'
import { createHarness } from './support/harness.ts'
import { returningDevice } from './support/page.ts'

// The sync guard, two devices through the S3 emulator (run under `bun scripts/with-s3.ts`): a mass deletion made on
// one device is held back on the other, which keeps showing its cards until the user decides.
test.use({ serviceWorkers: 'block' })

const S3 = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'cursus',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'cursus-secret',
  region: 'us-east-1',
}
const CARDS = 30
const TRASHED = 25
const PASSWORD = 'lock-123'

const harness = createHarness()

/** Uncaught exceptions only: a destination answering 404 to a probe logs to the console by design. */
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

async function newBucket(): Promise<string> {
  const admin = new AwsClient({ ...S3, service: 's3' })
  const bucket = `sync-hold-${crypto.randomUUID()}`
  const res = await admin.fetch(`${S3.endpoint}/${bucket}`, { method: 'PUT' })
  expect(res.status).toBe(200)
  return bucket
}

interface Device {
  context: BrowserContext
  page: Page
}

/** A device of the running project (its viewport, touch and user agent), with its own storage; seeded when asked. */
async function newDevice(browser: Browser, baseURL: string | undefined, seeded: boolean): Promise<Device> {
  const use = test.info().project.use
  const context = await browser.newContext({
    baseURL,
    serviceWorkers: 'block',
    storageState: returningDevice(baseURL ?? ''),
    ...(use.viewport ? { viewport: use.viewport } : {}),
    ...(use.userAgent ? { userAgent: use.userAgent } : {}),
    ...(use.deviceScaleFactor ? { deviceScaleFactor: use.deviceScaleFactor } : {}),
    ...(use.isMobile !== undefined && use.defaultBrowserType !== 'firefox' ? { isMobile: use.isMobile } : {}),
    ...(use.hasTouch !== undefined ? { hasTouch: use.hasTouch } : {}),
  })
  const page = await context.newPage()
  if (seeded) {
    const cards = Array.from({ length: CARDS }, (_, i) => ({
      front: `Plant question ${i + 1}?`,
      back: `Answer ${i + 1}`,
    }))
    await harness.seed(page, { courses: [{ title: 'Botany', cards }] })
  }
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: /Today/ })).toBeVisible()
  return { context, page }
}

/** Hash navigation inside the running page (no reload). */
async function go(page: Page, hash: string, heading: string | RegExp) {
  await page.evaluate((h) => {
    location.hash = h
  }, hash)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
}

async function addS3(page: Page, bucket: string) {
  await go(page, '#/settings/sync', 'Sync & backup')
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
}

async function syncNow(page: Page) {
  await go(page, '#/settings/sync', 'Sync & backup')
  const button = page.getByRole('button', { name: 'Sync now' })
  await button.click()
  await expect(button).toBeEnabled()
}

const cardRows = (page: Page) => page.getByRole('main').getByRole('link', { name: /Plant question/ })

/** Opens the course's cards (by its address: a banner may sit over the top of the screen). */
async function openCards(page: Page, course: string) {
  await go(page, course, 'Botany')
  await page.getByRole('radio', { name: 'Cards' }).check({ force: true })
}

async function courseHref(page: Page): Promise<string> {
  await go(page, '#/courses', 'Courses')
  const href = await page
    .getByRole('main')
    .getByRole('link', { name: /Botany/ })
    .first()
    .getAttribute('href')
  return `#${(href ?? '').replace(/^.*#/, '')}`
}

/** Device A, then device B, on one fresh bucket; B holds A's 30 cards. Returns the course's address. */
async function twoDevices(a: Device, b: Device): Promise<string> {
  const bucket = await newBucket()
  await addS3(a.page, bucket)
  await addS3(b.page, bucket)
  await syncNow(a.page)
  const course = await courseHref(a.page)
  await expect(async () => {
    await syncNow(b.page)
    await openCards(b.page, course)
    await expect(cardRows(b.page)).toHaveCount(CARDS, { timeout: 2_000 })
  }).toPass({ timeout: 60_000 })
  return course
}

/** A moves 25 of its cards to the trash, one by one in the card editor, then syncs. */
async function trashOnA(a: Page, course: string) {
  await openCards(a, course)
  const hrefs = await cardRows(a).evaluateAll((links) => links.map((l) => l.getAttribute('href') ?? ''))
  expect(hrefs.length).toBe(CARDS)
  for (const href of hrefs.slice(0, TRASHED)) {
    await go(a, `#${href.replace(/^.*#/, '')}`, /./)
    await a.getByRole('button', { name: 'Move to trash' }).click()
    await expect(a.getByRole('heading', { level: 1, name: 'Botany' })).toBeVisible()
  }
  await openCards(a, course)
  await expect(cardRows(a)).toHaveCount(CARDS - TRASHED)
  await syncNow(a)
}

const banner = (page: Page) =>
  page.getByRole('alert').filter({ hasText: 'Sync held back a deletion from another device' })

/** B syncs until it shows the banner: the deletion is held, nothing deleted there. */
async function heldOnB(b: Page, course: string) {
  await expect(async () => {
    await syncNow(b)
    await expect(banner(b)).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 60_000 })
  await expect(banner(b)).toContainText(`${TRASHED} items`)
  await expect(banner(b)).toContainText('Nothing was deleted here.')
  await openCards(b, course)
  await expect(cardRows(b)).toHaveCount(CARDS)
  await banner(b).getByRole('button', { name: 'Review' }).click()
  const sheet = b.getByRole('dialog', { name: 'Deletion held back' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText(`${TRASHED} cards`, { exact: true })).toBeVisible()
  await expect(sheet.getByText('Plant question 1?', { exact: true })).toBeVisible()
  return sheet
}

test('two devices through S3: a mass deletion is held on the other device; « Keep my data » brings it back on both', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000)
  const a = await newDevice(browser, baseURL, true)
  const b = await newDevice(browser, baseURL, false)
  try {
    const errors = [...watchErrors(a.page), ...watchErrors(b.page)]
    const course = await twoDevices(a, b)
    await trashOnA(a.page, course)
    const sheet = await heldOnB(b.page, course)

    await sheet.getByRole('button', { name: 'Keep my data' }).click()
    await expect(sheet).toBeHidden()
    await expect(banner(b.page)).toBeHidden()
    await openCards(b.page, course)
    await expect(cardRows(b.page)).toHaveCount(CARDS)

    // The restoration syncs out: A gets its cards back.
    await syncNow(b.page)
    await expect(async () => {
      await syncNow(a.page)
      await openCards(a.page, course)
      await expect(cardRows(a.page)).toHaveCount(CARDS, { timeout: 2_000 })
    }).toPass({ timeout: 60_000 })
    expect(errors).toEqual([])
  } finally {
    await a.context.close()
    await b.context.close()
  }
})

test('two devices through S3: « Apply the deletions » asks for the workspace password when one is set', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000)
  const a = await newDevice(browser, baseURL, true)
  const b = await newDevice(browser, baseURL, false)
  try {
    const errors = [...watchErrors(a.page), ...watchErrors(b.page)]
    const course = await twoDevices(a, b)

    // B protects destructive actions with a password.
    await go(b.page, '#/settings/security', 'Security')
    const section = b.page.getByRole('region', { name: 'Protect destructive actions' })
    await section.getByRole('button', { name: 'Set a password' }).click()
    await section.getByLabel('New password').fill(PASSWORD)
    await section.getByLabel('Confirm the password').fill(PASSWORD)
    await section.getByRole('button', { name: 'Save password' }).click()
    await expect(section.getByText('Password saved.')).toBeVisible()

    await trashOnA(a.page, course)
    const sheet = await heldOnB(b.page, course)
    await sheet.getByRole('button', { name: 'Apply the deletions' }).click()
    const prompt = b.page.getByRole('dialog', { name: 'Password required' })
    await expect(prompt).toBeVisible()
    // Nothing applied before the password.
    await expect(banner(b.page)).toBeVisible()
    await prompt.getByLabel('Password').fill(PASSWORD)
    await prompt.getByRole('button', { name: 'Continue' }).click()
    await expect(prompt).toBeHidden()
    await expect(banner(b.page)).toBeHidden()
    await openCards(b.page, course)
    await expect(cardRows(b.page)).toHaveCount(CARDS - TRASHED)
    expect(errors).toEqual([])
  } finally {
    await a.context.close()
    await b.context.close()
  }
})
