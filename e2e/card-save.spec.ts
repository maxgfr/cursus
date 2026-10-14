import { expect, type Page, test } from '@playwright/test'

// The card editor edits a draft: nothing reaches the card until Save.
test.use({ serviceWorkers: 'block' })

async function createCourse(page: Page, title: string) {
  await page.goto('./#/courses')
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill(title)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

async function typeInto(page: Page, label: string, text: string) {
  await page.getByRole('textbox', { name: label }).click()
  await page.keyboard.type(text)
}

const save = (page: Page) => page.getByRole('button', { name: /^Save( ⌘S| Ctrl\+S)?$/ })
const cardRows = (page: Page) => page.getByRole('main').getByRole('list').getByRole('link')

test('a new card exists only once saved; Save & new keeps going; Cancel leaves no empty card', async ({ page }) => {
  await createCourse(page, 'Botany')
  await page.getByRole('button', { name: 'New card' }).click()
  await expect(save(page)).toBeDisabled()
  // Cancel without changes just leaves, and creates nothing.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Botany' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No cards yet' })).toBeVisible()

  await page.getByRole('button', { name: 'New card' }).click()
  await typeInto(page, 'Front', 'Xylem carries?')
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible()
  await page.getByRole('button', { name: 'Save & new' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Front' })).toBeFocused()
  await typeInto(page, 'Front', 'Phloem carries?')
  await save(page).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Botany' })).toBeVisible()
  await expect(page.getByText('Card saved.')).toBeVisible()
  await expect(cardRows(page)).toHaveText([/Xylem carries\?/, /Phloem carries\?/])
})

test('typing changes nothing until Save; Save survives a reload; a reload mid-draft restores it', async ({ page }) => {
  await createCourse(page, 'Zoology')
  await page.getByRole('button', { name: 'New card' }).click()
  await typeInto(page, 'Front', 'Fish breathe with?')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByRole('heading', { level: 1, name: 'Zoology' })).toBeVisible()
  const row = page.getByRole('main').getByRole('link', { name: /Fish breathe with\?/ })
  await page.reload()
  await expect(row).toBeVisible()

  // Edit without saving: the course still shows the saved text.
  await row.click()
  await typeInto(page, 'Front', ' Gills')
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible()
  await page.waitForTimeout(400) // the draft is kept on the device a moment after typing
  await page.reload()
  await expect(page.getByText('Unsaved draft restored.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Front' })).toContainText('Fish breathe with? Gills')

  // Back with changes asks once; Discard drops the draft and the card keeps its saved text.
  await page.getByRole('link', { name: 'Back' }).click()
  const ask = page.getByRole('dialog', { name: 'Discard changes?' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Zoology' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: /Gills/ })).toHaveCount(0)
  await page
    .getByRole('main')
    .getByRole('link', { name: /Fish breathe with\?/ })
    .click()
  await expect(page.getByRole('textbox', { name: 'Front' })).not.toContainText('Gills')
  await expect(save(page)).toBeDisabled()

  // Moving it to the trash still offers Undo.
  await page.getByRole('button', { name: 'Move to trash' }).click()
  // The toast's Undo is a full 44px touch target.
  const undoBox = await page.getByRole('button', { name: 'Undo' }).boundingBox()
  expect(undoBox?.height ?? 0).toBeGreaterThanOrEqual(44)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('main').getByRole('link', { name: /Fish breathe with\?/ })).toBeVisible()
})

test('a double-click on Save, or a held ⌘S, creates exactly one card', async ({ page }) => {
  await createCourse(page, 'Mycology')
  await page.getByRole('button', { name: 'New card' }).click()
  await typeInto(page, 'Front', 'Spores spread by?')
  await save(page).dblclick()
  await expect(page.getByRole('heading', { level: 1, name: 'Mycology' })).toBeVisible()
  await expect(cardRows(page)).toHaveText([/Spores spread by\?/])

  await page.getByRole('button', { name: 'New card' }).click()
  await typeInto(page, 'Front', 'Hyphae form a?')
  // A held key: one press, then repeats.
  await page.keyboard.down('ControlOrMeta')
  await page.keyboard.down('s')
  await page.keyboard.down('s')
  await page.keyboard.down('s')
  await page.keyboard.up('s')
  await page.keyboard.up('ControlOrMeta')
  await expect(page.getByRole('heading', { level: 1, name: 'Mycology' })).toBeVisible()
  await page.reload()
  await expect(cardRows(page)).toHaveText([/Spores spread by\?/, /Hyphae form a\?/])
})
