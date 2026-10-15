import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

const FIXTURES = join(import.meta.dirname, 'fixtures')

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

async function openToday(page: Page) {
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
}

async function createCourse(page: Page, title: string) {
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill(title)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

async function typeInto(page: Page, label: string, text: string) {
  const box = page.getByRole('textbox', { name: label })
  await box.click()
  await page.keyboard.type(text)
}

/** Contrast is measured on the settled screen, not mid-fade (a sheet entering, a button enabling). */
async function settle(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY,
            ).length,
      ),
    )
    .toBe(0)
}

async function seriousViolations(page: Page): Promise<string[]> {
  await settle(page)
  return serious(await new AxeBuilder({ page }).analyze())
}

/** Axe scoped to the open modal: the dimmed page behind it is inert and not what is checked. */
async function dialogViolations(page: Page): Promise<string[]> {
  await settle(page)
  return serious(await new AxeBuilder({ page }).include('dialog[open]').analyze())
}

function serious(r: Awaited<ReturnType<AxeBuilder['analyze']>>): string[] {
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}

test('Today: first-launch state, "+" action, due counts and the exam countdown', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await expect(page.getByRole('heading', { name: 'Start with a course' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'New here? Set up Cursus' })).toBeVisible()

  // The header "+" opens the same sheet as the empty state's action.
  await expect(page.getByRole('button', { name: 'New course' })).toHaveCount(2)
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill('Physiology')
  expect(await dialogViolations(page)).toEqual([])
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Physiology' })).toBeVisible()

  // Exam in 12 days, set from the course settings. Days are study days, as in the app: one starts at 04:00, so
  // between midnight and 04:00 it is still the previous one, and the date counts from that day.
  const exam = await page.evaluate(() => {
    const d = new Date()
    if (d.getHours() < 4) d.setDate(d.getDate() - 1)
    d.setDate(d.getDate() + 12)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })
  await page.getByRole('button', { name: 'Course settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Course settings' })
  await settings.getByLabel('Exam date').fill(exam)
  expect(await dialogViolations(page)).toEqual([])
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('12 days left')).toBeVisible()

  // One card makes one new card due today.
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  await typeInto(page, 'Front', 'What does the sinoatrial node do?')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Card added.')).toBeVisible()
  await page.goto('./#/')
  // One sentence: the count and "due today" together, no eyebrow above it.
  await expect(page.getByRole('heading', { level: 2, name: '1 card due today' })).toBeVisible()
  await expect(page.getByText('Due today', { exact: true })).toHaveCount(0)
  // The nearest exam leads the session and is named under the total.
  await expect(page.getByTestId('exam-lead')).toHaveText('incl. 1 in Physiology · 12 days left')
  // Nothing confirmed a copy yet: one calm line leads to a backup.
  // It adds what the sync chip doesn't say: storage status is stated once.
  await expect(page.getByTestId('backup-line')).toContainText('No backup yet')
  await expect(page.getByTestId('backup-line')).not.toContainText(/this device/i)
  await expect(page.getByRole('link', { name: 'Add a backup' })).toHaveAttribute('href', /settings\/sync/)
  await expect(page.getByText(/≈ \d+/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
  const row = page.getByRole('main').getByRole('link', { name: /Physiology/ })
  await expect(row).toContainText('12 days left')
  await expect(row).toContainText('Exam in 12 days')
  // The meta keeps the card count alone; the due count trails the row as in the sidebar, spelled out
  // for screen readers.
  await expect(row.getByText('1 card', { exact: true })).toBeVisible()
  await expect(row.getByTestId('course-due')).toHaveText('11 due today')
  await expect(row.getByTestId('course-due').locator('[aria-hidden="true"]')).toHaveText('1')
  expect(await row.getByTestId('course-due').evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toContain(
    'tabular-nums',
  )
  expect(await seriousViolations(page)).toEqual([])
  expect(errors).toEqual([])
})

test('Course settings: a past exam date does not block renaming the course', async ({ page }) => {
  const errors = watchErrors(page)
  await page.clock.install({ time: new Date('2026-08-20T10:00:00') })
  await openToday(page)
  await createCourse(page, 'Anatomy')
  await page.getByRole('button', { name: 'Course settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Course settings' })
  await settings.getByLabel('Exam date').fill('2026-09-01')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings).toBeHidden()

  // The exam is over: the stored date is now in the past, and the course is renamed.
  await page.clock.setSystemTime(new Date('2026-10-14T10:00:00'))
  await page.getByRole('button', { name: 'Course settings' }).click()
  await expect(settings.getByLabel('Exam date')).toHaveValue('2026-09-01')
  await settings.getByLabel('Course name').fill('Anatomy I')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name: 'Anatomy I' })).toBeVisible()
  expect(errors).toEqual([])
})

test('Courses list has its own "+" and lists every course', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('./#/courses')
  await expect(page.getByRole('heading', { level: 1, name: 'Courses' })).toBeVisible()
  await createCourse(page, 'Organic chemistry')
  await page.goto('./#/courses')
  await expect(page.getByRole('main').getByRole('link', { name: /Organic chemistry/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('Sources: a note, a PDF opened natively, a photo and a pasted text', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Biology')
  await page.getByRole('radio', { name: 'Sources' }).check()

  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: 'Write a note' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled note' })).toBeVisible()
  await typeInto(page, 'Source', 'Mitochondria make ATP.')
  await page.waitForTimeout(300)
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Source' })).toContainText('Mitochondria make ATP.')
  await page.getByRole('link', { name: 'Back' }).click()

  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByLabel('Add files').setInputFiles(join(FIXTURES, 'sample.pdf'))
  await expect(page.getByRole('heading', { level: 1, name: 'sample' })).toBeVisible()
  // Read in the app, page by page; the original stays one tap away.
  await expect(page.getByText('2 slides')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Slide 2 Second page mitochondria' })).toBeVisible()
  await expect(page.getByText('This source is empty. Start writing.')).toBeHidden()
  const open = page.getByRole('link', { name: 'Open the original' })
  await expect(open).toHaveAttribute('href', /^blob:/)
  await expect(open).toHaveAttribute('target', '_blank')
  const pdf = await open.evaluate(async (a) => {
    const blob = await (await fetch((a as HTMLAnchorElement).href)).blob()
    return { type: blob.type, size: blob.size }
  })
  expect(pdf.type).toBe('application/pdf')
  expect(pdf.size).toBe((await readFile(join(FIXTURES, 'sample.pdf'))).length)
  await page.getByRole('link', { name: 'Back' }).click()

  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByLabel('Take a photo').setInputFiles(join(FIXTURES, 'large.png'))
  await expect(page.getByRole('heading', { level: 1, name: 'large' })).toBeVisible()
  const img = page.getByRole('img', { name: 'large' })
  await expect(img).toBeVisible()
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(2048)
  await page.getByRole('link', { name: 'Back' }).click()

  // ⌘V of plain text on the Sources tab becomes a note.
  await page.getByRole('radio', { name: 'Sources' }).check()
  await expect(page.getByText(/Tip: paste/)).toBeVisible()
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text/plain', 'Ribosomes build proteins.')
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  })
  await expect(page.getByRole('heading', { level: 1, name: 'Pasted note' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Source' })).toContainText('Ribosomes build proteins.')
  await page.getByRole('link', { name: 'Back' }).click()
  await page.getByRole('radio', { name: 'Sources' }).check()
  for (const name of ['Untitled note', 'sample', 'large', 'Pasted note']) {
    await expect(page.getByRole('main').getByRole('link', { name: new RegExp(name) })).toBeVisible()
  }
  expect(await seriousViolations(page)).toEqual([])
  expect(errors).toEqual([])
})

test('Sources: several files at once, each read by what it is, and files dropped on the course', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Genetics')
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByLabel('Add files').setInputFiles([
    { name: 'sample.pdf', mimeType: 'application/pdf', buffer: await readFile(join(FIXTURES, 'sample.pdf')) },
    { name: 'large.png', mimeType: 'image/png', buffer: await readFile(join(FIXTURES, 'large.png')) },
    { name: 'mendel.md', mimeType: 'text/markdown', buffer: Buffer.from('# Mendel\n\nPea plants.') },
  ])
  await expect(page.getByText('3 files added')).toBeVisible()
  await page.getByRole('button', { name: 'Dismiss' }).click()
  const main = page.getByRole('main')
  await expect(main.getByRole('link', { name: /sample/ })).toContainText('Slides')
  await expect(main.getByRole('link', { name: /large/ })).toContainText('Photo')
  await main.getByRole('link', { name: /mendel/ }).click()
  await expect(page.getByRole('textbox', { name: 'Source' })).toContainText('Pea plants.')
  await page.getByRole('link', { name: 'Back' }).click()

  // A file dropped anywhere on the Sources tab is added the same way.
  await page.getByRole('radio', { name: 'Sources' }).check()
  const pdf = (await readFile(join(FIXTURES, 'sample.pdf'))).toString('base64')
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], 'dropped.pdf', { type: 'application/pdf' }))
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  }, pdf)
  await expect(page.getByRole('heading', { level: 1, name: 'dropped' })).toBeVisible()
  await expect(page.getByText('2 slides')).toBeVisible()
  expect(errors).toEqual([])
})

test('New course from files: a proposed name, every file added, the course opens on its sources', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('From files…').setInputFiles([join(FIXTURES, 'sample.pdf'), join(FIXTURES, 'large.png')])
  await expect(dialog.getByText('2 files: sample.pdf, large.png')).toBeVisible()
  // The name comes from the first file and stays editable.
  await expect(dialog.getByLabel('Course name')).toHaveValue('sample')
  await dialog.getByLabel('Course name').fill('Cell biology')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Cell biology' })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Sources' })).toBeChecked()
  const main = page.getByRole('main')
  await expect(main.getByRole('link', { name: /sample/ })).toBeVisible()
  await expect(main.getByRole('link', { name: /large/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('Card editor: the cloze assistant hides phrases and previews one card each', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Cells')
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Card' })).toBeVisible()
  await page.getByRole('radio', { name: 'Fill in the blank' }).check()
  await typeInto(page, 'Text', 'The nucleus holds the DNA.')
  const phrase = page.getByLabel('Word or phrase to hide')
  await phrase.fill('nucleus')
  await page.getByRole('button', { name: 'Hide it' }).click()
  await phrase.fill('DNA')
  await page.getByLabel('Hint (optional)').fill('molecule')
  await page.getByRole('button', { name: 'Hide it' }).click()
  // The text reads with its answers marked; its Markdown source holds the deletions.
  const text = page.getByRole('textbox', { name: 'Text' })
  await expect(text.locator('.cm-md-cloze')).toHaveText(['nucleus', 'DNA'])
  const source = page.getByRole('button', { name: 'Show the Markdown source' }).first()
  await source.click()
  await expect(text).toContainText('The {{c1::nucleus}} holds the {{c2::DNA::molecule}}.')
  await source.click()
  const preview = page.getByRole('list', { name: '2 cards from this text' })
  await expect(preview.getByRole('listitem')).toHaveText([
    '1The [...] holds the DNA.',
    '2The nucleus holds the [molecule].',
  ])
  await phrase.fill('ribosome')
  await page.getByRole('button', { name: 'Hide it' }).click()
  await expect(page.getByText('This phrase isn’t in the text.')).toBeVisible()
  expect(await seriousViolations(page)).toEqual([])

  // The editor works on a draft: Save creates the card and goes back to the course.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Card added.')).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: /The nucleus holds the DNA\./ })).toBeVisible()
  expect(errors).toEqual([])
})

test('Trash: restore, then delete forever with the history caveat explained', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Law')
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  await typeInto(page, 'Front', 'Consideration')
  // A new card exists only once saved; then, opened again, it can go to the trash.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Card added.')).toBeVisible()
  // The toast can sit over the row on a phone.
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await page
    .getByRole('main')
    .getByRole('link', { name: /Consideration/ })
    .click()
  await page.getByRole('button', { name: 'Move to trash' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Law' })).toBeVisible()
  await page.getByRole('radio', { name: 'Cards' }).check()
  await expect(page.getByRole('heading', { name: /No cards yet/ })).toBeVisible()

  await page.goto('./#/trash')
  await expect(page.getByText(/your sync history still keeps a copy/)).toBeVisible()
  await page.getByRole('button', { name: 'Restore Consideration' }).click()
  await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible()
  // The empty state teaches with one sentence under its title.
  await expect(
    page.getByText('Deleted courses, sections, sources and cards wait here until you restore them.'),
  ).toBeVisible()
  await page.goto('./#/')
  await page.getByRole('main').getByRole('link', { name: /Law/ }).click()
  await expect(page.getByRole('main').getByRole('link', { name: /Consideration/ })).toBeVisible()

  await page.getByRole('button', { name: 'Course settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Course settings' })
  await settings.getByRole('button', { name: 'Delete course' }).click()
  await expect(settings.getByText(/goes to the trash/)).toBeVisible()
  expect(await dialogViolations(page)).toEqual([])
  await settings.getByRole('button', { name: 'Delete course' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Courses' })).toBeVisible()

  await page.goto('./#/trash')
  await expect(page.getByRole('button', { name: 'Restore Law' })).toBeVisible()
  expect(await seriousViolations(page)).toEqual([])
  await page.getByRole('button', { name: 'Delete Law forever' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete forever?' })
  await expect(confirm).toContainText('1 item will disappear')
  await expect(confirm).toContainText('never rewrites your sync history')
  expect(await dialogViolations(page)).toEqual([])
  await confirm.getByRole('button', { name: 'Delete forever' }).click()
  await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible()
  // The empty state teaches with one sentence under its title.
  await expect(
    page.getByText('Deleted courses, sections, sources and cards wait here until you restore them.'),
  ).toBeVisible()
  await page.goto('./#/courses')
  await expect(page.getByRole('main').getByRole('link', { name: /Law/ })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('History: replay to an earlier version, then restore it forward', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'History of art')
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: 'Write a note' }).click()
  const editor = page.getByRole('textbox', { name: 'Source' })
  await typeInto(page, 'Source', 'Version one.')

  // Opening History seals what was typed, so each visit records a version.
  await page.getByRole('link', { name: 'History', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible()
  await expect(page.getByText('1 version', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Back' }).click()
  // Replace the text only once the editor holds it, has focus and has selected all of it.
  await expect(editor).toHaveText('Version one.')
  await editor.click()
  await expect(editor).toBeFocused()
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+a')
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('Version one.')
  }).toPass()
  await page.keyboard.type('Version two.')
  await expect(editor).toHaveText('Version two.')
  await page.getByRole('link', { name: 'History', exact: true }).click()
  await expect(page.getByText('2 versions', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'This is the current text' })).toBeDisabled()

  await page.getByRole('button', { name: /^\S.* Version one\.$/ }).click()
  await expect(page.locator('pre')).toHaveText('Version one.')
  const restore = page.getByRole('button', { name: 'Restore this version' })
  await expect(restore).toBeEnabled()
  // Let the button's colour transition settle before measuring contrast.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
  expect(await seriousViolations(page)).toEqual([])
  await restore.click()
  await expect(page.getByRole('status').filter({ hasText: 'Restored.' })).toBeVisible()
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(editor).toHaveText('Version one.')
  expect(errors).toEqual([])
})

test('Onboarding: install first, Safari tab warning, storage health and an explicit demo course', async ({
  page,
  browserName,
}) => {
  const errors = watchErrors(page)
  await page.goto('./#/onboarding')
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Cursus' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Install Cursus first' })).toBeVisible()
  // A Safari tab keeps its own replica: warn there, and only there.
  const warning = page.getByRole('alert').filter({ hasText: 'You’re in a Safari tab.' })
  await expect(warning).toHaveCount(browserName === 'webkit' ? 1 : 0)

  await expect(page.getByRole('heading', { name: 'Storage on this device' })).toBeVisible()
  await expect(page.getByTestId('storage-persisted')).toHaveText(/Yes, persistent|Best effort/)
  await expect(page.getByTestId('storage-usage')).toHaveText(/ of |Not reported/)

  // Nothing is seeded: no course exists until the demo is asked for.
  await page.goto('./#/courses')
  await expect(page.getByRole('heading', { name: /No courses yet/ })).toBeVisible()
  await page.goto('./#/onboarding')
  expect(await seriousViolations(page)).toEqual([])
  await page.getByRole('button', { name: 'Try a demo course' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Demo: Cell biology' })).toBeVisible()
  // The demo shows every feature at the course's root: the back link, its two subsets, the suggested cards'
  // line and the two cards that live at the root (the rest sit in the subsets).
  const main = page.getByRole('main')
  await expect(main.getByRole('link', { name: 'Back' })).toBeVisible()
  await expect(main.getByRole('link', { name: /^Membranes\b/ })).toBeVisible()
  await expect(main.getByRole('link', { name: /^Organelles\b/ })).toBeVisible()
  const drafts = page.getByTestId('course-drafts')
  await expect(drafts).toContainText('7 suggested cards')
  await expect(drafts.getByRole('link', { name: 'Accept or edit' })).toBeVisible()
  await expect(main.getByRole('link', { name: /What is the smallest unit of life\?/ })).toBeVisible()
  await expect(main.getByRole('link', { name: /Why can’t a spherical cell keep growing\?/ })).toBeVisible()
  await expect(main.getByRole('link')).toHaveCount(6)
  await page.goto('./#/')
  await expect(page.getByRole('heading', { name: /due today$/ })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: /Demo: Cell biology/ })).toContainText('3 due')
  expect(errors).toEqual([])
})

test('first launch: an empty library opens the welcome once, which ends on a first course', async ({ browser }) => {
  // A device that never saw the welcome.
  const context = await browser.newContext({ serviceWorkers: 'block', storageState: { cookies: [], origins: [] } })
  const page = await context.newPage()
  const errors = watchErrors(page)
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Cursus' })).toBeVisible()
  // The loop in three steps, keeping data, AI only if wanted, then a course or the demo.
  await expect(page.getByRole('heading', { name: 'How Cursus works' })).toBeVisible()
  const steps = page.getByRole('main').getByRole('listitem')
  await expect(steps.filter({ hasText: 'Add what you study' })).toBeVisible()
  await expect(steps.filter({ hasText: 'Turn it into cards' })).toBeVisible()
  await expect(steps.filter({ hasText: 'Review a few minutes a day' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Storage on this device' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'On this device (free, offline)' })).toHaveAttribute(
    'href',
    /#\/settings\/ai\?setup=local$/,
  )
  await expect(page.getByRole('link', { name: 'With my own key' })).toHaveAttribute(
    'href',
    /#\/settings\/ai\?setup=key$/,
  )
  await expect(page.getByRole('button', { name: 'Try a demo course' })).toBeVisible()
  // The way out is a first course, not a jump to Today.
  await expect(page.getByRole('link', { name: 'Start' })).toHaveCount(0)
  expect(await seriousViolations(page)).toEqual([])

  // Seen once: an empty library now stays on Today.
  await page.getByRole('link', { name: 'Go to Today' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Start with a course' })).toBeVisible()

  await page.goto('./#/onboarding')
  await page.getByRole('button', { name: 'Create my first course' }).click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill('Anatomy')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Anatomy' })).toBeVisible()
  expect(errors).toEqual([])
  await context.close()
})
