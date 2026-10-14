import { expect, type Page, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

/** Collects console errors and uncaught exceptions for the whole test. */
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

async function openPalette(page: Page) {
  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox')).toBeFocused()
  return dialog
}

async function importCsv(page: Page, course: string, csv: string) {
  await page.goto('./#/stats')
  await expect(page.getByRole('heading', { level: 1, name: 'Statistics' })).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: `Import cards (CSV/TSV): ${course}` }).click()
  await (await chooser).setFiles({ name: 'cards.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
}

test('⌘K palette jumps to a screen and closes with Escape', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  let dialog = await openPalette(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  dialog = await openPalette(page)
  await page.keyboard.type('statis')
  await expect(dialog.getByRole('option', { name: 'Statistics' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'Statistics' })).toBeVisible()
  await expect(dialog).toBeHidden()
  expect(errors).toEqual([])
})

test('CSV import, accent-insensitive search in the palette and app badge', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: number[] = []
    Object.assign(window, { __badge: calls })
    Object.defineProperty(navigator, 'setAppBadge', {
      configurable: true,
      value: (n?: number) => {
        calls.push(n ?? 0)
        return Promise.resolve()
      },
    })
    Object.defineProperty(navigator, 'clearAppBadge', {
      configurable: true,
      value: () => {
        calls.push(0)
        return Promise.resolve()
      },
    })
  })
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Biology')
  await importCsv(page, 'Biology', 'front,back\nÉlève,Pupil\nMitochondrie,Powerhouse\n')
  await expect(page.getByRole('status').filter({ hasText: '2 cards imported' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __badge: number[] }).__badge.at(-1)))
    .toBeGreaterThan(0)

  const dialog = await openPalette(page)
  await page.keyboard.type('eleve')
  const hit = dialog.getByRole('option', { name: 'Élève' })
  await expect(hit).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await hit.click()
  await expect(page).toHaveURL(/#\/card\//)
  expect(errors).toEqual([])
})

test('⌘V outside a field captures text as a note in a chosen course', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'History')
  await openToday(page)
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text/plain', 'The treaty was signed in 1648.\nIt ended the war.')
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  const dialog = page.getByRole('dialog', { name: 'Add pasted text to…' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('option', { name: 'History' }).click()
  await expect(page).toHaveURL(/#\/source\//)
  await expect(page.getByRole('status').filter({ hasText: 'Note added to History' })).toBeVisible()
  expect(errors).toEqual([])
})

test('Stats: forecast, exam plan, share a course and calendar export', async ({ page }) => {
  // Force the download fallback so the share is deterministic on every engine.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined })
  })
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Chemistry')
  const exam = new Date(Date.now() + 12 * 86_400_000)
  const iso = `${exam.getFullYear()}-${String(exam.getMonth() + 1).padStart(2, '0')}-${String(exam.getDate()).padStart(2, '0')}`
  await page
    .getByRole('button', { name: /settings/i })
    .first()
    .click()
  await page.getByLabel('Exam date').fill(iso)
  await page.getByRole('button', { name: 'Save' }).click()
  await importCsv(page, 'Chemistry', 'front\tback\nH2O\tWater\nNaCl\tSalt\nCO2\tCarbon dioxide\n')
  await expect(page.getByRole('status').filter({ hasText: '3 cards imported' })).toBeVisible()

  await expect(page.getByRole('heading', { name: 'Next 7 days' })).toBeVisible()
  // One voice: the activity bars are neutral ink, never the accent.
  const barColours = await page.evaluate(() => {
    const accent = document.createElement('span')
    accent.style.color = 'var(--accent)'
    document.body.append(accent)
    const a = getComputedStyle(accent).color
    accent.remove()
    return {
      accent: a,
      bars: [...document.querySelectorAll('[data-bar]')].map((b) => getComputedStyle(b).backgroundColor),
    }
  })
  expect(barColours.bars.length).toBeGreaterThan(0)
  expect(barColours.bars).not.toContain(barColours.accent)
  await expect(page.getByText(/^D-1[12]: 1 card\/day$/)).toBeVisible()
  await expect(page.getByTestId('retention')).toHaveText('—')
  // No streaks anywhere.
  await expect(page.getByText(/streak/i)).toHaveCount(0)

  const shared = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Share course: Chemistry' }).click()
  expect((await shared).suggestedFilename()).toBe('Chemistry.cursus-course')

  const ics = page.waitForEvent('download')
  await page.getByText('Add study reminders to calendar (.ics)').click()
  const file = await ics
  expect(file.suggestedFilename()).toBe('cursus.ics')
  const path = await file.path()
  const { readFile } = await import('node:fs/promises')
  const body = await readFile(path, 'utf8')
  expect(body).toContain('BEGIN:VCALENDAR')
  expect(body).toContain('SUMMARY:Exam: Chemistry')
  expect(errors).toEqual([])
})
