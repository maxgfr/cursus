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
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  await expect(save(page)).toBeDisabled()
  // Cancel without changes just leaves, and creates nothing.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Botany' })).toBeVisible()
  await page.getByRole('radio', { name: 'Cards' }).check()
  await expect(page.getByRole('heading', { name: 'No cards yet' })).toBeVisible()

  await page.getByRole('radio', { name: 'Cards' }).check()
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
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  await typeInto(page, 'Front', 'Fish breathe with?')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByRole('heading', { level: 1, name: 'Zoology' })).toBeVisible()
  const row = page.getByRole('main').getByRole('link', { name: /Fish breathe with\?/ })
  await page.reload()
  await expect(row).toBeVisible()

  // Edit without saving: the course still shows the saved text.
  // The « Card saved. » toast can sit over the row on a phone.
  await page.getByRole('button', { name: 'Dismiss' }).click()
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
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  await typeInto(page, 'Front', 'Spores spread by?')
  await save(page).dblclick()
  await expect(page.getByRole('heading', { level: 1, name: 'Mycology' })).toBeVisible()
  await expect(cardRows(page)).toHaveText([/Spores spread by\?/])

  await page.getByRole('radio', { name: 'Cards' }).check()
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

/**
 * Keeps the given IndexedDB stores busy with a write transaction for `ms`: whatever reads or writes them waits
 * meanwhile, as on a loaded device.
 */
async function holdStores(page: Page, stores: string[], ms: number) {
  await page.evaluate(
    ({ stores, ms }) =>
      new Promise<void>((started, failed) => {
        const open = indexedDB.open('cursus-v1')
        open.onerror = () => failed(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction(stores, 'readwrite')
          const store = tx.objectStore(stores[0] ?? '')
          const end = performance.now() + ms
          const spin = () => {
            if (performance.now() < end) store.get('hold').onsuccess = spin
          }
          spin()
          tx.oncomplete = () => db.close()
          started()
        }
      }),
    { stores, ms },
  )
}

test('a Save still writing when the draft copy comes due leaves no draft: the next new card starts empty', async ({
  page,
}) => {
  await createCourse(page, 'Genetics')
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  await typeInto(page, 'Front', 'Genes are made of?')
  // The log is busy: Save waits for its write longer than the draft copy waits after the last keystroke.
  await holdStores(page, ['segments'], 1_000)
  await page.keyboard.type(' DNA')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByRole('heading', { level: 1, name: 'Genetics' })).toBeVisible()
  await expect(cardRows(page)).toHaveText([/Genes are made of\? DNA/])

  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  await expect(page.getByRole('textbox', { name: 'Front' })).toHaveText('')
  await expect(page.getByText('Unsaved draft restored.')).toHaveCount(0)
  await expect(save(page)).toBeDisabled()
})

test('the editor offers its actions only where they stay: a tap on Cancel cannot land on the form', async ({
  page,
}) => {
  await createCourse(page, 'Ecology')
  // The draft read waits: the editor is still loading when it first shows.
  await holdStores(page, ['kv'], 800)
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  const cancel = page.getByRole('button', { name: 'Cancel' })
  await expect(cancel).toBeVisible()
  const shown = await cancel.boundingBox()
  await expect(page.getByRole('textbox', { name: 'Front' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Back' })).toBeVisible()
  expect(await cancel.boundingBox()).toEqual(shown)
  await cancel.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Ecology' })).toBeVisible()
})
