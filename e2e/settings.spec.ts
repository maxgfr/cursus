import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { AwsClient } from 'aws4fetch'

// Settings screens of S-025. Destinations run against the S3 emulator of docker-compose.test.yml
// (`bun scripts/with-s3.ts`); OAuth providers are faked with page.route.
const S3 = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'cursus',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'cursus-secret',
  region: 'us-east-1',
}
const ANKI = resolve(import.meta.dirname, '../tests/fixtures/anki/modern.apkg')

test.use({ serviceWorkers: 'block' })

async function newBucket(): Promise<string> {
  const admin = new AwsClient({ ...S3, service: 's3' })
  const bucket = `settings-${crypto.randomUUID()}`
  const res = await admin.fetch(`${S3.endpoint}/${bucket}`, { method: 'PUT' })
  expect(res.status).toBe(200)
  return bucket
}

/** Segments the emulator holds in a bucket. */
async function segmentsIn(bucket: string): Promise<number> {
  const admin = new AwsClient({ ...S3, service: 's3' })
  const res = await admin.fetch(`${S3.endpoint}/${bucket}?list-type=2`)
  expect(res.status).toBe(200)
  return [...(await res.text()).matchAll(/<Key>[^<]*\/seg\/[^<]*<\/Key>/g)].length
}

async function open(page: Page, hash: string, heading: string | RegExp) {
  await page.goto(`./${hash}`)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
}

/** S3 is a technical destination: it waits behind the Advanced disclosure. */
async function openAdvanced(page: Page) {
  const s3 = page.getByRole('button', { name: 'S3-compatible storage' })
  if (!(await s3.isVisible())) await page.locator('summary', { hasText: 'Advanced' }).click()
  await expect(s3).toBeVisible()
}

async function fillS3(page: Page, o: { endpoint: string; bucket: string; secret?: string }) {
  await openAdvanced(page)
  await page.getByRole('button', { name: 'S3-compatible storage' }).click()
  const dialog = page.getByRole('dialog', { name: 'S3-compatible storage' })
  await dialog.getByLabel('Endpoint URL').fill(o.endpoint)
  await dialog.getByLabel('Bucket').fill(o.bucket)
  await dialog.getByLabel('Access key ID').fill(S3.accessKeyId)
  await dialog.getByLabel('Secret access key').fill(o.secret ?? S3.secretAccessKey)
  return dialog
}

async function addS3(page: Page, bucket: string) {
  await open(page, '#/settings/sync', 'Sync & backup')
  const dialog = await fillS3(page, { endpoint: S3.endpoint, bucket })
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeHidden()
  const row = page.getByRole('region', { name: 'Backups' }).getByRole('button', { name: new RegExp(bucket) })
  await expect(row).toBeVisible()
  return row
}

/** An empty state: its section, found by its title. */
const emptyState = (page: Page, title: string) =>
  page.getByRole('main').locator('section', { has: page.getByRole('heading', { name: title, exact: true }) })

async function createCourse(page: Page, title: string) {
  await open(page, '#/courses', 'Courses')
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill(title)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

test('S3: the connection test says what is wrong, then verify, restore drill and pause', async ({ page }) => {
  const bucket = await newBucket()
  await open(page, '#/settings/sync', 'Sync & backup')
  await expect(page.getByText('Your library lives only on this device')).toBeVisible()

  // Wrong secret: the keys are blamed, nothing is added.
  let dialog = await fillS3(page, { endpoint: S3.endpoint, bucket, secret: 'wrong-secret' })
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByRole('alert')).toContainText('The keys were refused')
  // Missing bucket.
  await dialog.getByLabel('Secret access key').fill(S3.secretAccessKey)
  await dialog.getByLabel('Bucket').fill(`${bucket}-missing`)
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByRole('alert')).toContainText('This bucket doesn’t exist')
  await dialog.getByLabel('Bucket').fill(bucket)
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByText('Connection works.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(/is connected\./)).toBeVisible()

  // A change is protected only once confirmed there.
  await createCourse(page, 'Pharmacology')
  await open(page, '#/settings/sync', 'Sync & backup')
  await expect(async () => {
    await page.getByRole('button', { name: 'Sync now' }).click()
    await expect(page.getByTestId('sync-summary')).toContainText('confirmed in 1 backup', { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })

  const row = page.getByRole('region', { name: 'Backups' }).getByRole('button', { name: new RegExp(bucket) })
  await row.click()
  dialog = page.getByRole('dialog', { name: new RegExp(bucket) })
  await dialog.getByRole('button', { name: 'Verify' }).click()
  await expect(dialog.getByText('Everything in this backup reads back intact.')).toBeVisible({ timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Restore drill' }).click()
  await expect(dialog.getByText('A new device would get exactly this library back.')).toBeVisible({ timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Pause' }).click()
  await expect(dialog.getByRole('button', { name: 'Resume' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(row).toContainText('Paused')
  // Paused survives a reload: the destination is remembered on this device.
  await open(page, '#/settings/sync', 'Sync & backup')
  await expect(row).toContainText('Paused')
  await row.click()
  await dialog.getByRole('button', { name: 'Resume' }).click()
  await expect(dialog.getByRole('button', { name: 'Pause' })).toBeVisible()

  // The diagnostic report says what happened, without any secret.
  await open(page, '#/settings/diagnostic', 'Diagnostics')
  await expect(page.locator('pre')).toContainText('"userAgent"')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export report' }).click()
  const report = await readFile(await (await download).path(), 'utf8')
  expect(report).toContain('"kind": "s3"')
  expect(report).not.toContain(S3.secretAccessKey)

  // The recovery sheet lists where the library lives, without keys.
  await open(page, '#/settings/recovery', 'Recovery')
  await expect(page.getByRole('heading', { name: 'Recovery sheet' })).toBeVisible()
  await expect(page.getByText(`${S3.endpoint} · ${bucket}/cursus`)).toBeVisible()
  await expect(page.getByText(S3.secretAccessKey)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Print recovery sheet' })).toBeVisible()
  await expect(page.getByText('cursus-v1')).toBeVisible()
})

test('S3: a bucket without CORS rules gets the rules to paste', async ({ page }) => {
  const endpoint = 'https://cors-blocked.example'
  // Answers every request without CORS headers: the browser hides the answer from the page.
  // The signed request gets no usable answer (as when CORS hides it); the bare probe reaches the server.
  await page.route(
    (url) => url.host === 'cors-blocked.example',
    (route) =>
      route.request().headers().authorization ? route.abort('failed') : route.fulfill({ status: 200, body: 'ok' }),
  )
  await open(page, '#/settings/sync', 'Sync & backup')
  const dialog = await fillS3(page, { endpoint, bucket: 'any' })
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByRole('alert')).toContainText('CORS rules don’t allow this site')
  const origin = new URL(page.url()).origin
  await expect(dialog.locator('pre')).toContainText(`"AllowedOrigins": [\n      "${origin}"`)
  await dialog.getByRole('radio', { name: 'MinIO' }).check()
  await expect(dialog.locator('pre')).toContainText(`<AllowedOrigin>${origin}</AllowedOrigin>`)
  await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeEnabled()
})

test('Dropbox: coming back from consent finishes the connection', async ({ page }) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
  await page.route('https://www.dropbox.com/**', (route) => {
    const state = new URL(route.request().url()).searchParams.get('state') ?? ''
    const back = new URL(`oauth-callback.html?code=granted&state=${encodeURIComponent(state)}`, page.url())
    // Like the consent page sending the user back (WebKit can't fulfil a 302 here).
    const html = `<!doctype html><meta http-equiv="refresh" content="0;url=${back.href}">`
    return route.fulfill({ status: 200, contentType: 'text/html', body: html })
  })
  let exchanged = ''
  const api = (route: import('@playwright/test').Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (new URL(req.url()).pathname === '/oauth2/token') {
      const body = req.postData() ?? ''
      if (body.includes('grant_type=authorization_code')) exchanged = body
      return route.fulfill({
        status: 200,
        headers: { ...cors, 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 14400, account_id: 'dbid:1' }),
      })
    }
    return route.fulfill({ status: 401, headers: { ...cors, 'content-type': 'application/json' }, body: '{}' })
  }
  await page.route('https://api.dropboxapi.com/**', api)
  await page.route('https://content.dropboxapi.com/**', api)

  await open(page, '#/settings/sync', 'Sync & backup')
  await page.getByRole('button', { name: /^Dropbox/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Dropbox' })
  await dialog.getByLabel('App key').fill('app-key-123')
  await dialog.getByRole('button', { name: 'Connect' }).click()
  // The provider sends the user back to the app with ?oauth=<key>: the app opens on Today and finishes
  // the connection there, without the Sync screen.
  await page.waitForURL(/\?oauth=oauth%3A/)
  await expect(page.getByRole('heading', { level: 1, name: /Today/ })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Dropbox is connected.' })).toBeVisible()
  expect(exchanged).toContain('code=granted')
  expect(exchanged).toContain('client_id=app-key-123')
  await page.evaluate(() => {
    location.hash = '#/settings/sync'
  })
  await expect(page.getByRole('region', { name: 'Backups' }).getByRole('button', { name: /Dropbox/ })).toBeVisible()
  expect(new URL(page.url()).searchParams.has('oauth')).toBe(false)
})

test('Dropbox: the form asks only for the app key, keeps Webhooks out, and shows the exact redirect URI', async ({
  page,
}) => {
  await open(page, '#/settings/sync', 'Sync & backup')
  await page.getByRole('button', { name: /^Dropbox/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Dropbox' })
  await expect(dialog.getByText(/Only the app key is needed: no app secret/)).toBeVisible()
  await expect(dialog.getByText(/leave Webhooks empty/)).toBeVisible()
  await expect(dialog.getByText(/OAuth 2 › Redirect URIs/)).toBeVisible()
  // This page's own callback, under the app's base path.
  const expected = new URL('oauth-callback.html', page.url()).href
  expect(expected).toMatch(/\/cursus\/oauth-callback\.html$/)
  await expect(dialog.getByTestId('redirect-uri')).toHaveText(expected)
  await expect(dialog.getByRole('button', { name: 'Copy address' })).toBeVisible()
  await expect(dialog.getByLabel('App key')).toBeVisible()
  await expect(dialog.getByLabel(/secret/i)).toHaveCount(0)
})

test('OneDrive: coming back from consent connects; a sign-in that expired asks to reconnect', async ({ page }) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
  let exchanged = ''
  let refreshed = 0
  await page.route('https://login.microsoftonline.com/**', (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname.endsWith('/authorize')) {
      const state = url.searchParams.get('state') ?? ''
      const back = new URL(`oauth-callback.html?code=granted&state=${encodeURIComponent(state)}`, page.url())
      const html = `<!doctype html><meta http-equiv="refresh" content="0;url=${back.href}">`
      return route.fulfill({ status: 200, contentType: 'text/html', body: html })
    }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const body = req.postData() ?? ''
    const headers = { ...cors, 'content-type': 'application/json' }
    if (body.includes('grant_type=authorization_code')) {
      exchanged = body
      return route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      })
    }
    // The 24-hour refresh token of a single-page app has run out.
    refreshed++
    return route.fulfill({ status: 400, headers, body: JSON.stringify({ error: 'invalid_grant' }) })
  })
  await page.route('https://graph.microsoft.com/**', (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 401, headers: { ...cors, 'content-type': 'application/json' }, body: '{}' }),
  )

  await open(page, '#/settings/sync', 'Sync & backup')
  await page.getByRole('button', { name: /^Microsoft OneDrive/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Microsoft OneDrive' })
  await expect(dialog.getByText(/no client secret/)).toBeVisible()
  await expect(dialog.getByTestId('redirect-uri')).toHaveText(new URL('oauth-callback.html', page.url()).href)
  await dialog.getByLabel('Application (client) ID').fill('client-123')
  await dialog.getByRole('button', { name: 'Connect' }).click()
  await page.waitForURL(/\?oauth=oauth%3A/)
  await expect(page.getByRole('status').filter({ hasText: 'OneDrive is connected.' })).toBeVisible()
  expect(exchanged).toContain('code=granted')
  expect(exchanged).toContain('client_id=client-123')
  expect(exchanged).toContain('code_verifier=')
  expect(exchanged).not.toContain('client_secret')
  await page.evaluate(() => {
    location.hash = '#/settings/sync'
  })
  const row = page.getByRole('region', { name: 'Backups' }).getByRole('button', { name: /OneDrive/ })
  await expect(row).toContainText('Sign in again to keep syncing', { timeout: 20_000 })
  expect(refreshed).toBeGreaterThan(0)
  await row.click()
  await expect(page.getByRole('dialog', { name: 'OneDrive' }).getByRole('button', { name: 'Reconnect' })).toBeVisible()
})

/** Moves inside the running app (no reload: the stubbed share sheet keeps what it received). */
async function within(page: Page, hash: string, heading: string | RegExp) {
  await page.evaluate((h) => {
    location.hash = h
  }, hash)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
}

test('Backup file: Save backup… hands the file to the share sheet, and Today recalls a week-old backup', async ({
  page,
}) => {
  // The share sheet of iPhone, stubbed: it records the files handed to it.
  await page.addInitScript(() => {
    const shared: { name: string; type: string; size: number }[] = []
    Object.assign(window, { __shared: shared })
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: (d: ShareData) => (d.files?.length ?? 0) > 0,
    })
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (d: ShareData) => {
        for (const f of d.files ?? []) shared.push({ name: f.name, type: f.type, size: f.size })
      },
    })
  })
  await createCourse(page, 'Cardiology')
  await page.goto('./#/')
  await page.getByRole('link', { name: 'Write a card' }).click()
  await page.getByRole('textbox', { name: 'Front' }).click()
  await page.keyboard.type('What does the sinoatrial node do?')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { level: 2, name: '1 card due today' })).toBeVisible()
  await expect(page.getByTestId('backup-line')).toContainText('No backup yet')

  await within(page, '#/settings/data', 'Data')
  await page.getByRole('button', { name: 'Save backup…' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Backup file saved.' })).toBeVisible({ timeout: 20_000 })
  const shared = await page.evaluate(
    () => (window as unknown as { __shared: { name: string; type: string; size: number }[] }).__shared,
  )
  expect(shared).toHaveLength(1)
  expect(shared[0]?.name).toMatch(/^cursus-\d{4}-\d{2}-\d{2}\.cursus$/)
  expect(shared[0]?.type).toBe('application/vnd.cursus+zip')
  expect(shared[0]?.size).toBeGreaterThan(0)
  await within(page, '#/', /Today/)
  await expect(page.getByTestId('backup-line')).toHaveCount(0)

  // Eight days later (the device kept the time of the last file), with no automatic backup.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('cursus-v1')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const tx = req.result.transaction('kv', 'readwrite')
          tx.objectStore('kv').put(Date.now() - 8 * 86_400_000, 'backup:lastExport')
          tx.oncomplete = () => {
            req.result.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
  )
  await within(page, '#/settings', 'Settings')
  await within(page, '#/', /Today/)
  await expect(page.getByTestId('backup-line')).toContainText('Last backup 8 days ago')
  await page.getByRole('link', { name: 'Save a backup' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Data' })).toBeVisible()
  await page.getByRole('button', { name: 'Save backup…' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Backup file saved.' })).toBeVisible({ timeout: 20_000 })
  await within(page, '#/', /Today/)
  await expect(page.getByRole('heading', { level: 2, name: '1 card due today' })).toBeVisible()
  await expect(page.getByTestId('backup-line')).toHaveCount(0)
})

test('a remembered backup syncs from launch, without opening Settings', async ({ page }) => {
  test.setTimeout(90_000)
  const bucket = await newBucket()
  await addS3(page, bucket)
  // A fresh launch on Today: Settings is never opened again.
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: /Today/ })).toBeVisible()
  const before = await segmentsIn(bucket)
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill('Virology')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Virology' })).toBeVisible()
  // Sealed after a quiet moment, then sent by the scheduler on its own.
  await expect.poll(() => segmentsIn(bucket), { timeout: 60_000 }).toBeGreaterThan(before)
})

test('Data: storage health, backup to a file and back on another device, Anki import and export', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000)
  await createCourse(page, 'Histology')
  await open(page, '#/settings/data', 'Data')
  await expect(page.getByRole('heading', { name: 'Storage on this device' })).toBeVisible()
  await expect(page.getByText(/Protected storage is on|Storage is not protected/)).toBeVisible()

  const saved = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export backup' }).click()
  const backup = await saved
  expect(backup.suggestedFilename()).toMatch(/^cursus-\d{4}-\d{2}-\d{2}\.cursus$/)
  const backupPath = await backup.path()

  // Another device (a fresh browser context) imports the file and gets the course.
  const other = await browser.newContext({ serviceWorkers: 'block' })
  const page2 = await other.newPage()
  await open(page2, '#/settings/data', 'Data')
  await page2.getByLabel('Import a backup file (.cursus)').setInputFiles(backupPath)
  await expect(page2.getByText(/new items? merged into this library/)).toBeVisible({ timeout: 20_000 })
  await open(page2, '#/courses', 'Courses')
  await expect(page2.getByRole('main').getByRole('link', { name: /Histology/ })).toBeVisible()
  await other.close()

  // A trashed subset that the package fills (deck Bio::Cells): the import says so and leads to the Trash.
  await createCourse(page, 'Bio')
  await page.getByRole('button', { name: 'New section' }).click()
  const newSection = page.getByRole('dialog', { name: 'New section' })
  await newSection.getByLabel('Section name').fill('Cells')
  await newSection.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Cells' })).toBeVisible()
  await page.getByRole('button', { name: 'Section settings' }).click()
  await page
    .getByRole('dialog', { name: 'Section settings' })
    .getByRole('button', { name: 'Move section to the trash' })
    .click()
  await expect(page.getByText('Section moved to the trash.')).toBeVisible()

  // Anki: a preview first, then the import on confirmation.
  await open(page, '#/settings/data', 'Data')
  await page.getByLabel('Choose an .apkg or .colpkg file').setInputFiles(ANKI)
  const confirm = page.getByRole('button', { name: /^Import \d+ cards?$/ })
  await expect(confirm).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Decks', { exact: true })).toBeVisible()
  await confirm.click()
  await expect(page.getByText(/\d+ cards? imported/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('New cards went into “Bio › Cells”, which is in the trash.')).toBeVisible()
  await page.getByRole('link', { name: 'Restore it from Trash' }).click()
  await expect(page).toHaveURL(/#\/trash$/)
  await expect(page.getByRole('main').getByText(/Cells/).first()).toBeVisible()

  // Export one course to Anki.
  await open(page, '#/settings/data', 'Data')
  const apkg = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export “Histology” to Anki' }).click()
  expect((await apkg).suggestedFilename()).toBe('Histology.apkg')
})

test('review preferences are written only on Save; the theme on pick', async ({ page }) => {
  await open(page, '#/settings/review', 'Schedule')
  const save = page.getByRole('button', { name: 'Save' })
  await expect(save).toBeDisabled()
  const daily = page.getByLabel('New cards per day')
  await expect(daily).toHaveValue('20')
  await daily.fill('15')
  await save.click()
  await expect(page.getByText(/^Saved\./)).toBeVisible()
  await page.waitForTimeout(300)
  await open(page, '#/settings/review', 'Schedule')
  await expect(page.getByLabel('New cards per day')).toHaveValue('15')

  await open(page, '#/settings/general', 'General')
  await page.getByRole('radio', { name: 'Dark' }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('sealing copies a backup encrypted and says the old copy stays', async ({ page }) => {
  test.setTimeout(90_000)
  const bucket = await newBucket()
  await createCourse(page, 'Toxicology')
  await addS3(page, bucket)
  await open(page, '#/settings/seal', 'Encryption')
  await expect(page.getByText('The old unencrypted copy stays there until you delete it yourself.')).toBeVisible()
  await page.getByLabel('Encryption passphrase').fill('correct horse battery')
  await page.getByLabel('Repeat passphrase').fill('correct horse battery')
  // Submitted from the keyboard: on phones a bottom prompt may cover the button.
  await page.getByLabel('Repeat passphrase').press('Enter')
  await expect(page.getByText(/objects? encrypted\./)).toBeVisible({ timeout: 60_000 })
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: `${bucket}` })
      .filter({ hasText: 'Encrypted' })
      .first(),
  ).toBeVisible()
})

test('Sync: three everyday backups say where they work, one is recommended, the technical ones wait behind Advanced', async ({
  page,
}) => {
  await open(page, '#/settings/sync', 'Sync & backup')
  // No separate empty state: the status line says it once, and "Add destination" is the one heading
  // over the list, whose Recommended row is the action.
  await expect(page.getByTestId('sync-summary')).toContainText('every change is copied there')
  await expect(page.getByRole('heading', { name: 'No copy yet' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Backups' })).toHaveCount(0)
  for (const name of [/^iCloud Drive/, /^Google Drive/, /^Dropbox/])
    await expect(page.getByRole('button', { name })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Google Drive/ })).toContainText('iPad and iPhone')
  await expect(page.getByText('Recommended', { exact: true })).toHaveCount(1)
  for (const name of ['S3-compatible storage', 'CloudKit', 'Folder on this device'])
    await expect(page.getByRole('button', { name })).toBeHidden()
  await openAdvanced(page)
  await expect(page.getByRole('button', { name: /^CloudKit/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /^Nearby device/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /^Backup file/ })).toBeVisible()
  // Drive and Dropbox say they need the student's own app key.
  await expect(page.getByRole('button', { name: /^Google Drive/ })).toContainText('Needs your own app key.')
  await expect(page.getByRole('button', { name: /^Dropbox/ })).toContainText('Needs your own app key.')
  // The Recommended row opens the recommended backup: iCloud Drive where it can be kept, else the backup file.
  await page.getByRole('main').getByText('Recommended', { exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: /iCloud Drive/ }).or(page.getByRole('heading', { level: 1, name: 'Data' })),
  ).toBeVisible()
})

test('Sync: the protection chip sits with the summary under the title, in French too', async ({ page }) => {
  await page.goto('./?locale=fr#/settings/sync')
  const title = page.getByRole('heading', { level: 1 })
  await expect(title).toBeVisible()
  const t = await title.boundingBox()
  const c = await page.locator('main [data-sync]').first().boundingBox()
  const p = await page.getByTestId('sync-summary').boundingBox()
  if (!t || !c || !p) throw new Error('missing box')
  expect(Math.abs(c.x - t.x)).toBeLessThanOrEqual(1)
  expect(c.y).toBeGreaterThan(t.y + t.height)
  expect(Math.abs(c.y - p.y)).toBeLessThanOrEqual(p.height)
})

test('Settings: four honest groups, no Search row, Sync & backup only once', async ({ page }) => {
  await open(page, '#/settings', 'Settings')
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText([
    'Keep your library safe',
    'Preferences',
    'Your data',
    'Help',
  ])
  await expect(page.getByRole('main').getByRole('link', { name: 'Search' })).toHaveCount(0)
  await expect(page.getByRole('main').getByText('Sync & backup', { exact: true })).toHaveCount(1)
})

test('Course: empty states teach and offer the next action; Back returns to Today; a trashed card can be undone', async ({
  page,
}) => {
  await createCourse(page, 'Histology')
  const main = page.getByRole('main')
  const title = await page.getByRole('heading', { level: 1, name: 'Histology' }).boundingBox()
  const meta = await main.getByText('0 cards').first().boundingBox()
  if (!title || !meta) throw new Error('missing box')
  // The dot leads the meta row, flush with the title.
  expect(meta.x - title.x).toBeLessThan(24)

  await page.getByRole('radio', { name: 'Cards' }).click()
  const cards = emptyState(page, 'No cards yet')
  await expect(cards.getByText('A card asks one thing')).toBeVisible()
  await expect(cards.getByRole('button', { name: 'New card' })).toBeVisible()
  await page.getByRole('radio', { name: 'Sources' }).click()
  const sources = emptyState(page, 'No sources yet')
  await expect(sources.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
  await page.getByRole('radio', { name: 'Study sheets' }).click()
  const sheets = emptyState(page, 'No study sheets yet')
  // Without a model the course offers no AI action (nor a setup link).
  await expect(sheets.getByRole('link')).toHaveCount(0)

  // A card moved to the trash comes back with Undo.
  await page.getByRole('radio', { name: 'Cards' }).click()
  await main.getByRole('button', { name: 'New card' }).first().click()
  await page.getByRole('textbox', { name: 'Front' }).click()
  await page.keyboard.type('Basement membrane')
  await page.keyboard.press('ControlOrMeta+s')
  // The « Card saved. » toast can sit over the row on a phone.
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await main.getByRole('link', { name: /Basement membrane/ }).click()
  await page.getByRole('button', { name: 'Move to trash' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Histology' })).toBeVisible()
  await expect(page.getByText('Card moved to the trash.')).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(main.getByRole('link', { name: /Basement membrane/ })).toBeVisible()
  await expect(page.getByText('Card moved to the trash.')).toBeHidden()

  // Opened from Today, the course goes back to Today.
  await open(page, '#/', 'Today')
  await main
    .getByRole('link', { name: /Histology/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Histology' })).toBeVisible()
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
})
