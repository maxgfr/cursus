import { expect, test } from '@playwright/test'
import { configureAi, providerPicker } from './support/ai'
import { createHarness } from './support/harness.ts'
import { seriousViolations, watchErrors } from './support/page.ts'

// « Erase everything on this device »: a two-step confirmation in a sheet, then the app starts afresh on the
// welcome, with no course and no AI key. Remote destinations are never touched (none is set up here).
test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

test('erasing this device leaves a fresh app on the welcome, with no course and no AI key', async ({ page }) => {
  const errors = watchErrors(page)
  await harness.seed(page, {
    courses: [{ title: 'Biology', cards: [{ front: 'Powerhouse of the cell?', back: 'The mitochondrion' }] }],
  })
  await configureAi(page, 'https://llm.mock.test/v1')

  await page.goto('./#/settings/data')
  await expect(page.getByRole('heading', { level: 1, name: 'Data' })).toBeVisible()
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
  await page.goto('./#/courses')
  await expect(page.getByRole('main').getByRole('link', { name: /Biology/ })).toHaveCount(0)
  await page.goto('./#/settings/ai')
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible()
  await expect(providerPicker(page)).toHaveValue('anthropic')
  await expect(page.getByLabel('API key')).toHaveValue('')
  expect(errors).toEqual([])
})
