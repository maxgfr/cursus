import { join } from 'node:path'
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from '@playwright/test'
import { AwsClient } from 'aws4fetch'

// Photos everywhere: capture through the file chooser, the gallery and full-screen viewer, a photo on a card in
// Review, two devices through the S3 emulator (run under `bun scripts/with-s3.ts`), "on demand", and a course
// package that keeps its photos.
test.use({ serviceWorkers: 'block' })

const FIXTURES = join(import.meta.dirname, 'fixtures')
const LARGE = join(FIXTURES, 'large.png') // 3000 × 1500

const S3 = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'cursus',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'cursus-secret',
  region: 'us-east-1',
}

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

/** A device of the running project (its viewport, touch and user agent), with its own storage. */
async function newDevice(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; page: Page }> {
  const use = test.info().project.use
  const context = await browser.newContext({
    baseURL,
    serviceWorkers: 'block',
    ...(use.viewport ? { viewport: use.viewport } : {}),
    ...(use.userAgent ? { userAgent: use.userAgent } : {}),
    ...(use.deviceScaleFactor ? { deviceScaleFactor: use.deviceScaleFactor } : {}),
    ...(use.isMobile !== undefined && use.defaultBrowserType !== 'firefox' ? { isMobile: use.isMobile } : {}),
    ...(use.hasTouch !== undefined ? { hasTouch: use.hasTouch } : {}),
  })
  // The share sheet differs per engine: the download fallback keeps the test deterministic.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined })
  })
  const page = await context.newPage()
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

async function createCourse(page: Page, title: string) {
  await go(page, '#/courses', 'Courses')
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill(title)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

async function openCourse(page: Page, title: string) {
  await go(page, '#/courses', 'Courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: new RegExp(title) })
    .first()
    .click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

/** The gallery is reached from the course's Sources tab, with the other ways to add material (not among the cards). */
async function openPhotos(page: Page) {
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page.getByRole('link', { name: /^Photos/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible()
}

/** The camera on a touch screen, the photo library elsewhere: both go through the system file chooser. */
async function choosePhoto(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  const camera = page.getByRole('button', { name: 'Take photo' })
  const button = (await camera.isVisible()) ? camera : page.getByRole('button', { name: 'Add photos' }).first()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()])
  await chooser.setFiles(file)
}

const tile = (page: Page, name: RegExp): Locator =>
  page.getByTestId('photo-tile').filter({ has: page.getByRole('link', { name }) })

const viewerWidth = (page: Page): Promise<number> =>
  page.getByTestId('viewer-photo').evaluate((img) => (img as HTMLImageElement).naturalWidth)

/** A PNG drawn in the page (a different photo from the fixture, so a different file). */
async function drawnPng(page: Page, width: number, height: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ w, h }) => {
      const canvas = new OffscreenCanvas(w, h)
      const g = canvas.getContext('2d')
      if (!g) throw new Error('no 2d context')
      g.fillStyle = '#2d6a4f'
      g.fillRect(0, 0, w, h)
      g.fillStyle = '#ffffff'
      g.fillRect(w / 8, h / 8, w / 2, h / 3)
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
      let s = ''
      for (const b of bytes) s += String.fromCharCode(b)
      return btoa(s)
    },
    { w: width, h: height },
  )
  return Buffer.from(b64, 'base64')
}

async function typeInto(page: Page, label: string, text: string) {
  await page.getByRole('textbox', { name: label }).click()
  await page.keyboard.type(text)
}

const save = (page: Page) => page.getByRole('button', { name: /^Save( ⌘S| Ctrl\+S)?$/ }).first()

/** The first card in Review shows its photo, loaded from this device's files. */
async function expectPhotoInReview(page: Page, alt: string) {
  await page.goto('./#/review')
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible()
  const img = page.getByTestId('question').getByRole('img', { name: alt })
  await expect(img).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => img.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}

test('capture through the file chooser, the full-screen viewer, and a photo on a card in Review', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await newDevice(browser, baseURL)
  try {
    const errors = watchErrors(page)
    await createCourse(page, 'Anatomy')
    await openPhotos(page)
    await expect(page.getByRole('heading', { name: 'No photos yet' })).toBeVisible()
    await choosePhoto(page, LARGE)
    await expect(page.getByRole('status').filter({ hasText: '1 photo added' })).toBeVisible()
    await expect(tile(page, /^large$/)).toHaveAttribute('data-state', 'ready')

    // Full screen: reduced to 2048 px on this device, zoom, rotation, caption.
    await page.getByRole('link', { name: 'large' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'large' })).toBeVisible()
    await expect.poll(() => viewerWidth(page)).toBe(2048)
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await expect(page.getByRole('button', { name: 'Fit to screen' })).toHaveText('Zoom 150%')
    await page.getByRole('button', { name: 'Fit to screen' }).click()
    await page.getByRole('button', { name: 'Rotate right' }).click()
    await expect.poll(() => viewerWidth(page)).toBe(1024)
    await page.getByLabel('Caption').fill('Skeleton')
    await page.getByLabel('Caption').press('Enter')
    await expect(page.getByRole('status').filter({ hasText: 'Caption saved' })).toBeVisible()
    await expect(page.getByTestId('viewer-photo')).toHaveAttribute('alt', 'Skeleton')

    // Shared as it is shown (download where no share sheet takes files).
    const shared = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    expect((await shared).suggestedFilename()).toBe('Skeleton.jpg')

    // A card with this photo on its front, saved, then reviewed.
    await page.getByRole('button', { name: 'New card with this photo' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Card' })).toBeVisible()
    await expect(page.getByTestId('card-photo')).toHaveCount(1)
    await expect(page.getByTestId('card-photo').getByRole('img', { name: 'Skeleton' })).toBeVisible()
    // The photo shows in the editor, under its line, and in the side's preview.
    const front = page.locator('section', { has: page.getByRole('heading', { name: 'Front' }) })
    const inEditor = front.locator('.cm-photoPreview').getByRole('img', { name: 'Skeleton' })
    await expect(inEditor).toBeVisible()
    expect(await inEditor.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await front.getByRole('button', { name: 'Preview' }).click()
    await expect(front.getByRole('img', { name: 'Skeleton' }).last()).toBeVisible()
    await front.getByRole('button', { name: 'Write' }).click()
    await typeInto(page, 'Back', 'The bones')
    await save(page).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Card' })).toBeHidden()
    await expectPhotoInReview(page, 'Skeleton')
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
})

test('a shared then imported course keeps its photos', async ({ browser, baseURL }) => {
  const a = await newDevice(browser, baseURL)
  const b = await newDevice(browser, baseURL)
  try {
    const errors = [...watchErrors(a.page), ...watchErrors(b.page)]
    await createCourse(a.page, 'Botany')
    await openPhotos(a.page)
    await choosePhoto(a.page, LARGE)
    await expect(tile(a.page, /^large$/)).toHaveAttribute('data-state', 'ready')
    await a.page.getByRole('link', { name: 'large' }).click()
    await a.page.getByRole('button', { name: 'New card with this photo' }).click()
    await typeInto(a.page, 'Back', 'A leaf')
    await save(a.page).click()
    await expect(a.page.getByRole('heading', { level: 1, name: 'Card' })).toBeHidden()

    await go(a.page, '#/stats', /Stat/)
    const download = a.page.waitForEvent('download')
    await a.page.getByRole('button', { name: 'Share course: Botany' }).click()
    const file = await download
    expect(file.suggestedFilename()).toBe('Botany.cursus-course')
    const path = await file.path()

    // Another device: the package brings the photo's file, not just its name.
    await go(b.page, '#/settings/data', 'Data')
    await b.page.locator('input[type="file"][aria-labelledby="data-course-import"]').setInputFiles(path)
    await expect(b.page.getByRole('status').filter({ hasText: 'Course imported.' })).toBeVisible()
    await openCourse(b.page, 'Botany')
    await openPhotos(b.page)
    await expect(tile(b.page, /^large$/)).toHaveAttribute('data-state', 'ready')
    await b.page.getByRole('link', { name: 'large' }).click()
    await expect.poll(() => viewerWidth(b.page)).toBe(2048)
    await expectPhotoInReview(b.page, 'large')
    expect(errors).toEqual([])
  } finally {
    await a.context.close()
    await b.context.close()
  }
})

async function newBucket(): Promise<string> {
  const admin = new AwsClient({ ...S3, service: 's3' })
  const bucket = `photos-${crypto.randomUUID()}`
  const res = await admin.fetch(`${S3.endpoint}/${bucket}`, { method: 'PUT' })
  expect(res.status).toBe(200)
  return bucket
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

/** Syncs device `page` until its gallery of `course` shows the photo `name` in `state`. */
async function syncUntilTile(page: Page, course: string, name: RegExp, state: 'ready' | 'remote') {
  await expect(async () => {
    await syncNow(page)
    await openCourse(page, course)
    await openPhotos(page)
    await expect(tile(page, name)).toHaveAttribute('data-state', state, { timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
}

test('two devices through S3: a photo taken on one appears on the other; on demand, it downloads when opened', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000)
  const bucket = await newBucket()
  const a = await newDevice(browser, baseURL)
  const b = await newDevice(browser, baseURL)
  try {
    const errors = [...watchErrors(a.page), ...watchErrors(b.page)]
    await addS3(a.page, bucket)
    await addS3(b.page, bucket)

    // Taken on A, it reaches B with its file ("all", the default).
    await createCourse(a.page, 'Histology')
    await openPhotos(a.page)
    await choosePhoto(a.page, LARGE)
    await expect(tile(a.page, /^large$/)).toHaveAttribute('data-state', 'ready')
    await syncNow(a.page)
    await syncUntilTile(b.page, 'Histology', /^large$/, 'ready')

    // B keeps photos on demand: the next one is listed at once, and downloads only when opened.
    await go(b.page, '#/settings/data', 'Data')
    await b.page.getByTestId('photo-mode').getByRole('radio', { name: 'On demand' }).check()
    await expect(b.page.getByText('Photos stay listed and download when you open them')).toBeVisible()
    await openCourse(a.page, 'Histology')
    await openPhotos(a.page)
    await choosePhoto(a.page, { name: 'slide.png', mimeType: 'image/png', buffer: await drawnPng(a.page, 1200, 900) })
    await expect(tile(a.page, /^slide$/)).toHaveAttribute('data-state', 'ready')
    await syncNow(a.page)
    await syncUntilTile(b.page, 'Histology', /^slide/, 'remote')
    await expect(tile(b.page, /^large$/)).toHaveAttribute('data-state', 'ready')

    // Opened as a source, it downloads too, instead of saying the file is missing.
    const href =
      (await tile(b.page, /^slide/)
        .getByRole('link')
        .getAttribute('href')) ?? ''
    const slideId = /photo\/([^/?#]+)/.exec(href)?.[1] ?? 'missing-photo'
    await go(b.page, `#/source/${slideId}`, 'slide')
    await expect
      .poll(
        () =>
          b.page
            .getByRole('main')
            .getByRole('img', { name: 'slide', exact: true })
            .evaluate((img) => (img as HTMLImageElement).naturalWidth),
        { timeout: 30_000 },
      )
      .toBe(1200)
    await expect(b.page.getByText('This file hasn’t reached this device yet.', { exact: false })).toHaveCount(0)
    await openCourse(b.page, 'Histology')
    await openPhotos(b.page)

    await b.page.getByRole('link', { name: /^slide/ }).click()
    await expect(b.page.getByRole('heading', { level: 1, name: 'slide' })).toBeVisible()
    await expect.poll(() => viewerWidth(b.page), { timeout: 30_000 }).toBe(1200)
    await b.page.getByRole('button', { name: 'Close' }).click()
    await expect(b.page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible()
    await expect(tile(b.page, /^slide$/)).toHaveAttribute('data-state', 'ready')
    expect(errors).toEqual([])
  } finally {
    await a.context.close()
    await b.context.close()
  }
})
