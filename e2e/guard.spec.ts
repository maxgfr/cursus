import { expect, type Page, test } from '@playwright/test'
import { createHarness } from './support/harness.ts'
import { seriousViolations, watchErrors } from './support/page.ts'

// « Protect destructive actions »: a device-only password asked before erasing, deleting forever or removing a
// sync destination. A lock against accidents, not encryption; forgetting it leaves only « erase this device ».
test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

const PASSWORD = 'lock-123'

async function seed(page: Page) {
  await harness.seed(page, {
    courses: [{ title: 'Biology', cards: [{ front: 'Powerhouse of the cell?', back: 'The mitochondrion' }] }],
  })
}

async function setPassword(page: Page) {
  await page.goto('./#/settings/security')
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible()
  const section = page.getByRole('region', { name: 'Protect destructive actions' })
  await expect(section.getByText(/not encryption/)).toBeVisible()
  await expect(section.getByText('No password is set.')).toBeVisible()
  await section.getByRole('button', { name: 'Set a password' }).click()
  await section.getByLabel('New password').fill('short')
  await section.getByLabel('Confirm the password').fill('short')
  await section.getByRole('button', { name: 'Save password' }).click()
  await expect(section.getByText('Use at least 6 characters.')).toBeVisible()
  await section.getByLabel('New password').fill(PASSWORD)
  await section.getByLabel('Confirm the password').fill(PASSWORD)
  await section.getByRole('button', { name: 'Save password' }).click()
  await expect(section.getByText('Password saved.')).toBeVisible()
  await expect(section.getByText('A password protects destructive actions on this device.')).toBeVisible()
}

async function trashCourse(page: Page) {
  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .click()
  await page.getByRole('button', { name: 'Course settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Course settings' })
  await settings.getByRole('button', { name: 'Delete course' }).click()
  await settings.getByRole('button', { name: 'Delete course' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Courses' })).toBeVisible()
}

async function deleteForever(page: Page) {
  await page.goto('./#/trash')
  await page.getByRole('button', { name: 'Delete Biology forever' }).click()
  await page.getByRole('dialog', { name: 'Delete forever?' }).getByRole('button', { name: 'Delete forever' }).click()
}

test('a set password guards « Delete forever » and « Erase everything », and removing it lifts the guard', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const errors = watchErrors(page)
  await seed(page)
  await setPassword(page)
  await trashCourse(page)

  // Wrong password: an error, nothing deleted.
  await deleteForever(page)
  const prompt = page.getByRole('dialog', { name: 'Password required' })
  await expect(prompt).toBeVisible()
  expect(await seriousViolations(page, 'dialog[open]')).toEqual([])
  await prompt.getByLabel('Password').fill('wrong-one')
  await prompt.getByRole('button', { name: 'Continue' }).click()
  await expect(prompt.getByText('Wrong password. Try again.')).toBeVisible()
  await prompt.getByRole('button', { name: 'Close' }).click()
  await expect(prompt).toBeHidden()
  await page.getByRole('dialog', { name: 'Delete forever?' }).getByRole('button', { name: 'Cancel' }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Restore Biology' })).toBeVisible()

  // Right password: deleted.
  await deleteForever(page)
  await prompt.getByLabel('Password').fill(PASSWORD)
  await prompt.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible({ timeout: 15_000 })

  // « Erase everything » asks too, after its own confirmation.
  await page.goto('./#/settings/security')
  await page.getByRole('button', { name: 'Erase everything on this device' }).click()
  const erase = page.getByRole('dialog', { name: 'Erase everything on this device' })
  await erase.getByRole('checkbox', { name: 'I understand this can’t be undone' }).check()
  await erase.getByRole('button', { name: 'Erase this device' }).click()
  await expect(prompt).toBeVisible()
  await prompt.getByRole('button', { name: 'Close' }).click()
  await erase.getByRole('button', { name: 'Close' }).click()

  // Removing the password needs the current one; then nothing asks.
  const section = page.getByRole('region', { name: 'Protect destructive actions' })
  await section.getByRole('button', { name: 'Remove password' }).click()
  await section.getByLabel('Current password').fill('wrong-one')
  await section.getByRole('button', { name: 'Remove password' }).click()
  await expect(section.getByText('Wrong password. Try again.')).toBeVisible()
  await section.getByLabel('Current password').fill(PASSWORD)
  await section.getByRole('button', { name: 'Remove password' }).click()
  await expect(section.getByText(/Password removed/)).toBeVisible()
  await expect(section.getByText('No password is set.')).toBeVisible()

  await page.getByRole('button', { name: 'Erase everything on this device' }).click()
  await erase.getByRole('checkbox', { name: 'I understand this can’t be undone' }).check()
  await erase.getByRole('button', { name: 'Erase this device' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Cursus' })).toBeVisible({ timeout: 15_000 })
  await expect(prompt).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a forgotten password: erasing this device is the way out, after typing the word', async ({ page }) => {
  test.setTimeout(90_000)
  const errors = watchErrors(page)
  await seed(page)
  await setPassword(page)
  await trashCourse(page)
  await deleteForever(page)
  const prompt = page.getByRole('dialog', { name: 'Password required' })
  await prompt.getByRole('button', { name: 'Forgot your password?' }).click()
  const forgot = page.getByRole('dialog', { name: 'Forgot your password?' })
  await expect(forgot.getByText(/only way out is to erase everything on this device/)).toBeVisible()
  expect(await seriousViolations(page, 'dialog[open]')).toEqual([])
  const confirm = forgot.getByRole('button', { name: 'Erase this device' })
  await expect(confirm).toBeDisabled()
  await forgot.getByLabel('Type ERASE to confirm').fill('ERAS')
  await expect(confirm).toBeDisabled()
  await forgot.getByLabel('Type ERASE to confirm').fill('ERASE')
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Cursus' })).toBeVisible({ timeout: 15_000 })
  await page.goto('./#/courses')
  await expect(page.getByRole('main').getByRole('link', { name: /Biology/ })).toHaveCount(0)
  // The password went with the device's data.
  await page.goto('./#/settings/security')
  await expect(
    page.getByRole('region', { name: 'Protect destructive actions' }).getByText('No password is set.'),
  ).toBeVisible()
  expect(errors).toEqual([])
})

test('in German at 375 px the password prompt fits the screen', async ({ page }) => {
  test.setTimeout(90_000)
  const errors = watchErrors(page)
  await seed(page)
  await setPassword(page)
  await page.setViewportSize({ width: 375, height: 740 })
  await page.goto('./?locale=de#/settings/security')
  await page.getByRole('button', { name: 'Alles auf diesem Gerät löschen' }).click()
  const erase = page.getByRole('dialog', { name: 'Alles auf diesem Gerät löschen' })
  await erase.getByRole('checkbox').check()
  await erase.getByRole('button', { name: 'Dieses Gerät leeren' }).click()
  const prompt = page.getByRole('dialog', { name: 'Passwort nötig' })
  await expect(prompt).toBeVisible()
  const overflow = () =>
    page.evaluate(() => {
      const ds = [...document.querySelectorAll('dialog[open]')]
      const d = ds[ds.length - 1]
      return d ? d.scrollWidth - d.clientWidth : -1
    })
  expect(await overflow()).toBe(0)
  await prompt.getByRole('button', { name: 'Passwort vergessen?' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Passwort vergessen?' }).getByLabel('Tippe LÖSCHEN zur Bestätigung'),
  ).toBeVisible()
  expect(await overflow()).toBe(0)
  expect(await seriousViolations(page, 'dialog[open]')).toEqual([])
  expect(errors).toEqual([])
})
