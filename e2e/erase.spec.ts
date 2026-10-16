import { expect, test } from '@playwright/test'
import { configureAi, providerPicker } from './support/ai'
import { createHarness } from './support/harness.ts'
import { seriousViolations, watchErrors } from './support/page.ts'
import { addS3, bucketKeys, newBucket } from './support/s3.ts'

// « Erase everything on this device »: a two-step confirmation in a sheet, then the app starts afresh on the
// welcome, with no course, no AI key, no destination and none of the app's databases or keys. The sync stops first,
// and the remote copy is never touched (run under `bun scripts/with-s3.ts`).
test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

test('erasing this device leaves a fresh app on the welcome: no course, no AI key, no destination, nothing kept', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await harness.seed(page, {
    courses: [{ title: 'Biology', cards: [{ front: 'Powerhouse of the cell?', back: 'The mitochondrion' }] }],
  })
  await configureAi(page, 'https://llm.mock.test/v1')
  // Synced to S3: the remote copy is there before, and stays after.
  const bucket = await newBucket('erase')
  await addS3(page, bucket)
  await page.getByRole('button', { name: 'Sync now' }).click()
  await expect.poll(async () => (await bucketKeys(bucket)).length, { timeout: 30_000 }).toBeGreaterThan(0)
  const remote = await bucketKeys(bucket)
  // What else the app keeps on the device: an older database, a remembered width, a pending return.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        localStorage.setItem('cursus:chat:width', '420')
        sessionStorage.setItem('cursus:pendingBack', '{}')
        const req = indexedDB.open('cursus-old')
        req.onsuccess = () => {
          req.result.close()
          resolve()
        }
        req.onerror = () => reject(req.error)
      }),
  )

  await page.goto('./#/settings/security')
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible()
  await page.getByRole('button', { name: 'Erase everything on this device' }).click()
  const sheet = page.getByRole('dialog', { name: 'Erase everything on this device' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('AI keys and on-device models')).toBeVisible()
  await expect(sheet.getByText(/keep their copy: nothing is deleted there/)).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Download a backup first' })).toBeVisible()

  // Two steps: the button waits for the student to say they understand.
  const confirm = sheet.getByRole('button', { name: 'Erase this device' })
  await expect(confirm).toBeDisabled()
  expect(await seriousViolations(page, '[role="dialog"], dialog[open]')).toEqual([])
  await sheet.getByRole('checkbox', { name: 'I understand this can’t be undone' }).check()
  await expect(confirm).toBeEnabled()
  await confirm.click()

  // Reloaded at the root: the welcome, as on a first launch.
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Cursus' })).toBeVisible({ timeout: 15_000 })
  const kept = await page.evaluate(async () => ({
    databases: (await indexedDB.databases()).map((d) => d.name ?? ''),
    keys: [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.startsWith('cursus:')),
  }))
  expect(kept.databases).not.toContain('cursus-old')
  // Nothing from before: the only key is the one the welcome just wrote (it has been seen).
  expect(kept.keys).toEqual(['cursus:onboarded'])
  expect(await bucketKeys(bucket)).toEqual(expect.arrayContaining(remote))
  await page.goto('./#/courses')
  await expect(page.getByRole('main').getByRole('link', { name: /Biology/ })).toHaveCount(0)
  await page.goto('./#/settings/ai')
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible()
  await expect(providerPicker(page)).toHaveValue('anthropic')
  await expect(page.getByLabel('API key')).toHaveValue('')
  await page.goto('./#/settings/sync')
  await expect(page.getByRole('heading', { level: 1, name: 'Sync & backup' })).toBeVisible()
  await expect(page.getByRole('main')).not.toContainText(bucket)
  await expect(page.getByRole('button', { name: 'Sync now' })).toHaveCount(0)
  // A destination answering 404 to a probe (an empty bucket) logs to the console by design; nothing else may.
  expect(errors.filter((e) => !/responded with a status of 404/.test(e))).toEqual([])
})
