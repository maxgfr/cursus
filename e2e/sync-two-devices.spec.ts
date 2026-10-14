import { type Browser, type BrowserContext, chromium, expect, type Page, test, webkit } from '@playwright/test'
import { AwsClient } from 'aws4fetch'

// One Chromium device and one WebKit device, each its own browser, syncing through the S3 emulator
// of docker-compose.test.yml (run under `bun scripts/with-s3.ts`). The destination is configured
// through the Sync settings screen, exactly as a user would.
const S3 = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'cursus',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'cursus-secret',
  region: 'us-east-1',
}

async function newBucket(): Promise<string> {
  const admin = new AwsClient({ ...S3, service: 's3' })
  const bucket = `two-devices-${crypto.randomUUID()}`
  const res = await admin.fetch(`${S3.endpoint}/${bucket}`, { method: 'PUT' })
  expect(res.status).toBe(200)
  return bucket
}

/** Hash navigation inside the running page: no reload, so it also works offline. */
async function go(page: Page, hash: string, heading: string | RegExp) {
  await page.evaluate((h) => {
    location.hash = h
  }, hash)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
}

const chip = (page: Page) => page.locator('[data-sync]').first()

async function addS3(page: Page, bucket: string) {
  await go(page, '#/settings/sync', 'Sync & backup')
  // S3 is a technical destination: it waits behind Advanced.
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
  await expect(page.getByRole('button', { name: new RegExp(`${bucket} · localhost:9000`) })).toBeVisible()
}

async function createCourse(page: Page, title: string) {
  await go(page, '#/', /Today/)
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill(title)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

async function syncNow(page: Page) {
  await go(page, '#/settings/sync', 'Sync & backup')
  const button = page.getByRole('button', { name: 'Sync now' })
  await button.click()
  await expect(button).toBeEnabled()
}

async function expectCourses(page: Page, titles: string[]) {
  await go(page, '#/courses', 'Courses')
  for (const title of titles)
    await expect(page.getByRole('main').getByRole('link', { name: new RegExp(title) })).toBeVisible()
}

/** Syncs until the device shows every course: a round may still be confirming the previous one. */
async function syncUntil(page: Page, titles: string[]) {
  await expect(async () => {
    await syncNow(page)
    await expectCourses(page, titles)
  }).toPass({ timeout: 30_000 })
}

test('a Chromium and a WebKit device merge concurrent offline edits through S3', async ({ baseURL }) => {
  test.setTimeout(180_000)
  const bucket = await newBucket()
  const browsers: Browser[] = [await chromium.launch(), await webkit.launch()]
  const contexts: BrowserContext[] = []
  try {
    const [a, b] = await Promise.all(
      browsers.map(async (browser) => {
        const context = await browser.newContext({ baseURL, serviceWorkers: 'block' })
        contexts.push(context)
        const page = await context.newPage()
        await page.goto('./#/')
        await expect(page.getByRole('heading', { level: 1, name: /Today/ })).toBeVisible()
        return page
      }),
    )
    if (!a || !b) throw new Error('two devices expected')

    // Both devices get the same destination, through the UI.
    await addS3(a, bucket)
    await addS3(b, bucket)

    // The chip says "protected" only once the change is confirmed on the destination…
    await createCourse(a, 'Chemistry')
    await go(a, '#/', /Today/)
    await expect(chip(a)).toHaveAttribute('data-sync', /.+/)
    await expect(chip(a)).not.toHaveAttribute('data-sync', 'protected')
    await expect(async () => {
      await syncNow(a)
      await expect(chip(a)).toHaveAttribute('data-sync', 'protected', { timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
    await expect(a.getByTestId('sync-summary')).toContainText('confirmed on 1 destination')
    // …and drops it right after a new local edit.
    await createCourse(a, 'Dynamics')
    await go(a, '#/', /Today/)
    await expect(chip(a)).toHaveAttribute('data-sync', /.+/)
    await expect(chip(a)).not.toHaveAttribute('data-sync', 'protected')
    await syncNow(a)
    await syncUntil(b, ['Chemistry', 'Dynamics'])

    // Warm every screen the offline part uses (chunks load over the network), then cut both devices off.
    for (const page of [a, b]) {
      await go(page, '#/course/warm-up', /./)
      await go(page, '#/courses', 'Courses')
      await go(page, '#/', /Today/)
    }
    await Promise.all(contexts.map((c) => c.setOffline(true)))
    await createCourse(a, 'Anatomy')
    await createCourse(b, 'Botany')
    for (const page of [a, b]) {
      await go(page, '#/settings/sync', 'Sync & backup')
      await expect(chip(page)).toHaveAttribute('data-sync', 'offline')
    }
    await expectCourses(a, ['Anatomy', 'Chemistry', 'Dynamics'])
    await expectCourses(b, ['Botany', 'Chemistry', 'Dynamics'])
    await expect(a.getByRole('main').getByRole('link', { name: /Botany/ })).toHaveCount(0)

    // Back online: both edits survive on both devices.
    await Promise.all(contexts.map((c) => c.setOffline(false)))
    const all = ['Anatomy', 'Botany', 'Chemistry', 'Dynamics']
    await syncNow(a)
    await syncUntil(b, all)
    await syncUntil(a, all)
    for (const page of [a, b]) {
      await expect(async () => {
        await syncNow(page)
        await expect(chip(page)).toHaveAttribute('data-sync', 'protected', { timeout: 2_000 })
      }).toPass({ timeout: 30_000 })
    }
  } finally {
    for (const browser of browsers) await browser.close()
  }
})
