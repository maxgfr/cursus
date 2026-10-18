import { type BrowserContext, expect, type Page, test } from '@playwright/test'

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
/** The course's own « New card » (the « Card added » toast offers one too, after it). */
const newCard = (page: Page) => page.getByRole('main').getByRole('button', { name: 'New card' }).first()

test('a new card exists only once saved; « New card » after saving keeps going; Cancel leaves no empty card', async ({
  page,
}) => {
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
  // One Save: back on the course, the notice offers the next card straight away.
  await save(page).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Botany' })).toBeVisible()
  await expect(page.getByText('Card added.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save & new' })).toHaveCount(0)
  await page.getByRole('status').getByRole('button', { name: 'Add another' }).click()
  await expect(page.getByRole('textbox', { name: 'Front' })).toBeFocused()
  await expect(page.getByRole('textbox', { name: 'Front' })).toHaveText('')
  await expect(save(page)).toBeDisabled()
  await typeInto(page, 'Front', 'Phloem carries?')
  await save(page).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Botany' })).toBeVisible()
  await expect(page.getByText('Card added.')).toBeVisible()
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
  // The « Card added. » toast can sit over the row on a phone.
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
  await newCard(page).click()
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
  await newCard(page).click()
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

/**
 * Opens `url` in a page of its own whose editor code is held back until `release`: the editor arrives after the
 * screen. A page of its own, as WebKit reloading a page takes the code it already has without asking for it again.
 */
async function openLate(context: BrowserContext, url: string) {
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const page = await context.newPage()
  await page.route(/\/assets\/MarkdownEditorImpl-[\w-]+\.js$/, async (route) => {
    await released
    await route.continue()
  })
  await page.goto(url)
  await expect(page.getByText('Opening the editor…').first()).toBeVisible()
  return { page, release }
}

test('a new card has the cursor in its front however late the editor arrives; an existing card leaves it be', async ({
  page,
  context,
}) => {
  await createCourse(page, 'Optics')
  const front = page.getByRole('textbox', { name: 'Front' })
  // A fresh page: the editor's code comes with the first card opened.
  await page.getByRole('radio', { name: 'Cards' }).check()
  await newCard(page).click()
  await expect(front).toBeFocused()
  const editor = page.url()
  await page.keyboard.type('Light bends in?')
  await expect(front).toHaveText('Light bends in?')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByRole('heading', { level: 1, name: 'Optics' })).toBeVisible()

  // Opened by its address, the page loading with it.
  await page.goto(editor)
  await page.reload()
  await expect(front).toBeFocused()
  await page.keyboard.type('A lens has a?')
  await expect(front).toHaveText('A lens has a?')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByRole('heading', { level: 1, name: 'Optics' })).toBeVisible()

  // The editor's code arrives well after the screen: the cursor still lands in the front once it is there.
  const late = await openLate(context, editor)
  late.release()
  const lateFront = late.page.getByRole('textbox', { name: 'Front' })
  await expect(lateFront).toBeFocused()
  await late.page.keyboard.type('Prisms split?')
  await expect(lateFront).toHaveText('Prisms split?')
  await late.page.getByRole('button', { name: 'Cancel' }).click()
  await late.page.getByRole('dialog', { name: 'Discard changes?' }).getByRole('button', { name: 'Discard' }).click()
  await expect(late.page.getByRole('heading', { level: 1, name: 'Optics' })).toBeVisible()
  await late.page.close()

  // Meanwhile focused elsewhere, the focus stays there.
  const busy = await openLate(context, editor)
  const cancel = busy.page.getByRole('button', { name: 'Cancel' })
  await cancel.focus()
  busy.release()
  await expect(busy.page.getByRole('textbox', { name: 'Front' })).toBeVisible()
  await expect(cancel).toBeFocused()
  await expect(busy.page.getByRole('textbox', { name: 'Front' })).not.toBeFocused()
  await busy.page.close()

  // « New card », Cancel, then « New card » again: the cursor is back in the front each time.
  await page.getByRole('radio', { name: 'Cards' }).check()
  await expect(cardRows(page)).toHaveText([/Light bends in\?/, /A lens has a\?/])
  await newCard(page).click()
  await expect(front).toBeFocused()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Optics' })).toBeVisible()
  await page.getByRole('radio', { name: 'Cards' }).check()
  await newCard(page).click()
  await expect(front).toBeFocused()
  await expect(front).toHaveText('')
  await page.getByRole('button', { name: 'Cancel' }).click()

  // An existing card opens without taking the focus: typing changes nothing.
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page
    .getByRole('main')
    .getByRole('link', { name: /Light bends in\?/ })
    .click()
  await expect(front).toHaveText('Light bends in?')
  await expect(front).not.toBeFocused()
  await page.keyboard.type('x')
  await expect(front).toHaveText('Light bends in?')
  await expect(save(page)).toBeDisabled()
})

test('« Save and add another » writes cards on the fly: each one saved, the next one empty in the same section', async ({
  page,
}) => {
  await createCourse(page, 'Anatomy')
  const course = page.url()
  await page.getByRole('button', { name: 'New section' }).click()
  const dialog = page.getByRole('dialog', { name: 'New section' })
  await dialog.getByLabel('Section name').fill('Bones')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Bones' })).toBeVisible()
  const section = page.url()
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).first().click()
  // A new card's route is its place: the next card stays on it, and no entry is pushed for it.
  await expect(page).toHaveURL(/#\/card\/new\.[^.]+\.[^.]+$/)
  const editor = page.url()
  const front = page.getByRole('textbox', { name: 'Front' })
  const saveNext = page.getByRole('button', { name: 'Save and add another', exact: true })
  await expect(saveNext).toHaveAttribute('aria-keyshortcuts', 'Meta+Shift+Enter Control+Shift+Enter')
  await expect(saveNext).toBeDisabled()

  const fronts = ['Femur is in the?', 'Tibia is in the?', 'Ulna is in the?']
  for (const [i, text] of fronts.entries()) {
    await typeInto(page, 'Front', text)
    await typeInto(page, 'Back', 'Answer')
    await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible()
    // The button, then the shortcut, then the button again.
    if (i === 1) await page.keyboard.press('ControlOrMeta+Shift+Enter')
    else await saveNext.click()
    // Still the editor: the next card, empty, the cursor in its front, the last one said added.
    await expect(page.getByRole('status').filter({ hasText: 'Card added.' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Card' })).toBeVisible()
    expect(page.url()).toBe(editor)
    await expect(front).toHaveText('')
    await expect(page.getByRole('textbox', { name: 'Back' })).toHaveText('')
    await expect(front).toBeFocused()
    await expect(saveNext).toBeDisabled()
    await expect(save(page)).toBeDisabled()
  }

  // Saved for good, and no draft left of them: a reload starts the next card empty too.
  await page.reload()
  await expect(front).toHaveText('')
  await expect(page.getByText('Unsaved draft restored.')).toHaveCount(0)

  // Back lands on the section, with the three cards; the browser's back then goes to the course.
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Bones' })).toBeVisible()
  expect(page.url()).toBe(section)
  await page.getByRole('radio', { name: 'Cards' }).check()
  await expect(page.getByRole('main').getByRole('link', { name: / is in the\?/ })).toHaveText(
    fronts.map((f) => new RegExp(f.replace('?', '\\?'))),
  )
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'Anatomy' })).toBeVisible()
  expect(page.url()).toBe(course)
})
