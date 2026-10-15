import { readFile } from 'node:fs/promises'
import { expect, type Page, test } from '@playwright/test'
import { createHarness } from './support/harness.ts'
import { seriousViolations, settle, watchErrors } from './support/page.ts'

test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

const LAW = {
  title: 'Law',
  cards: [
    { front: 'What is consideration?', back: 'Something of value exchanged' },
    { front: 'What is an offer?', back: 'A promise open to acceptance' },
    { front: 'What is estoppel?', back: 'A bar on going back on one’s word' },
  ],
}

async function openToday(page: Page, query = '') {
  await page.goto(`./${query}#/`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}

/** Reveals the card on screen and gives it a grade. */
async function answer(page: Page, grade: 'Again' | 'Good') {
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: new RegExp(`^${grade},`) }).click()
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test('Cramming from Today: all cards outside the schedule, a summary, the missed ones relaunched', async ({ page }) => {
  const errors = watchErrors(page)
  await harness.seed(page, { courses: [LAW] })
  await openToday(page)
  await expect(page.getByRole('heading', { level: 2, name: '3 cards due today' })).toBeVisible()

  await page.getByRole('link', { name: 'New session' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'New session' })).toBeVisible()
  await expect(page.getByLabel('Cards from')).toHaveValue('')
  // Due by default: it counts toward the schedule, and new cards are not due cards.
  const counts = page.getByRole('switch', { name: 'Count toward the schedule' })
  await expect(page.getByRole('radio', { name: 'Due', exact: true })).toBeChecked()
  await expect(counts).toBeChecked()
  await expect(page.getByTestId('session-preview')).toHaveText('No card matches. Try another type or a wider scope.')
  await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled()

  // "All" goes through everything: off the schedule by default, and the count follows live.
  await page.getByRole('radio', { name: 'All', exact: true }).check()
  await expect(counts).not.toBeChecked()
  await expect(
    page.getByText('Cramming: your answers are kept apart and leave review dates as they are.'),
  ).toBeVisible()
  await expect(page.getByTestId('session-preview')).toHaveText('3 cards in this session')
  await page.getByLabel('Number of cards').fill('0')
  await expect(page.getByText('Enter a whole number from 1 to 999.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled()
  await page.getByLabel('Number of cards').fill('2')
  await expect(page.getByTestId('session-preview')).toHaveText('2 cards in this session')
  await page.getByRole('button', { name: 'Start session' }).click()

  // The run is named and marked as cramming.
  await expect(page.getByRole('heading', { level: 1, name: 'All cards' })).toBeVisible()
  await expect(page.getByTestId('cramming')).toHaveText('Cramming')
  await expect(page.getByTestId('remaining')).toHaveText('2 left')
  await answer(page, 'Again')
  await answer(page, 'Good')
  // A session is its own queue: it ends on its results, nothing waits to come back.
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('You reviewed 2 cards.')).toBeVisible()
  await expect(page.getByText('You missed 1 card.')).toBeVisible()

  await page.getByRole('button', { name: 'Relaunch the missed ones' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Missed cards' })).toBeVisible()
  await expect(page.getByTestId('cramming')).toBeVisible()
  await expect(page.getByTestId('remaining')).toHaveText('1 left')
  await answer(page, 'Good')
  await expect(page.getByText('Nothing missed.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Relaunch the missed ones' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Done' }).click()

  // Back where it was set up from, and the schedule is untouched: the three new cards are still due.
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: '3 cards due today' })).toBeVisible()

  // The history keeps both runs, newest first, each with its results.
  await page.goto('./#/sessions')
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()
  const past = page.getByRole('region', { name: 'Past sessions' })
  await expect(past.getByRole('listitem')).toHaveCount(2)
  await expect(past.getByRole('listitem').nth(0)).toContainText('Missed cards')
  await expect(past.getByTestId('session-facts').nth(0)).toContainText('1 card')
  await expect(past.getByRole('listitem').nth(1)).toContainText('All cards')
  await expect(past.getByTestId('session-facts').nth(1)).toContainText('2 cards · 1 missed')
  await expect(past.getByTestId('cramming')).toHaveCount(2)
  await expect(past.getByRole('button', { name: 'Relaunch the missed ones: All cards' })).toBeVisible()

  // Stats count the cramming apart from the scheduled reviews.
  await page.goto('./#/stats')
  await expect(page.getByTestId('cramming-tile')).toContainText('3 reviews')
  await expect(page.getByTestId('cramming-tile')).toContainText('66.7% recalled · outside your schedule')
  await expect(page.getByText('incl. 3 cramming')).toBeVisible()
  await expect(page.getByTestId('retention')).toHaveText('—')
  expect(errors).toEqual([])
})

test('A session from a course counts toward the schedule; keyboard only', async ({ page }) => {
  const errors = watchErrors(page)
  await harness.seed(page, { courses: [LAW, { title: 'Biology', cards: [{ front: 'Cell?', back: 'Unit of life' }] }] })
  await openToday(page)
  await expect(page.getByRole('heading', { level: 2, name: '4 cards due today' })).toBeVisible()
  await page.getByRole('main').getByRole('link', { name: /^Law/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Law' })).toBeVisible()
  await page.getByRole('button', { name: 'New session' }).click()

  // The course is the scope; arrow keys move the type, and the toggle follows it until it is set by hand.
  await expect(page.getByLabel('Cards from')).toHaveValue(/^c:/)
  await expect(page.getByLabel('Cards from').locator('option:checked')).toHaveText('Law')
  const due = page.getByRole('radio', { name: 'Due', exact: true })
  await due.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('radio', { name: 'Ahead', exact: true })).toBeChecked()
  await expect(page.getByRole('switch', { name: 'Count toward the schedule' })).not.toBeChecked()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('radio', { name: 'New', exact: true })).toBeChecked()
  await expect(page.getByRole('switch', { name: 'Count toward the schedule' })).toBeChecked()
  await expect(page.getByTestId('session-preview')).toHaveText('3 cards in this session')
  // Return in the count field starts the session.
  await page.getByLabel('Number of cards').fill('2')
  await page.getByLabel('Number of cards').press('Enter')

  await expect(page.getByRole('heading', { level: 1, name: 'New cards · Law' })).toBeVisible()
  await expect(page.getByTestId('cramming')).toHaveCount(0)
  for (let i = 0; i < 2; i++) {
    await expect(page.getByTestId('question')).toBeVisible()
    await page.keyboard.press('Space')
    await expect(page.getByTestId('answer')).toBeVisible()
    await page.keyboard.press('3')
  }
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { level: 1, name: 'Law' })).toBeVisible()

  // Counted: the two cards left today's due count (they are now learning).
  await openToday(page)
  await expect(page.getByRole('heading', { level: 2, name: '2 cards due today' })).toBeVisible()
  await page.goto('./#/sessions')
  const past = page.getByRole('region', { name: 'Past sessions' })
  await expect(past.getByRole('listitem')).toHaveCount(1)
  await expect(past.getByRole('listitem')).toContainText('New cards · Law')
  await expect(past.getByTestId('cramming')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Planned sessions: create, show on Today, edit, add to calendar, delete with undo', async ({ page }) => {
  const errors = watchErrors(page)
  await harness.seed(page, { courses: [LAW] })
  await page.goto('./#/sessions')
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()
  await expect(page.getByText('Sessions you start show up here with their results.')).toBeVisible()
  await page.getByRole('button', { name: 'Plan a session' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'New planned session' })).toBeVisible()

  // Nothing is saved without a name or a day.
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Give this session a name.')).toBeVisible()
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
    await page.getByRole('checkbox', { name: day }).uncheck()
  await page.getByLabel('Name').fill('Evening law')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Pick at least one day.')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'New planned session' })).toBeVisible()

  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
    await page.getByRole('checkbox', { name: day }).check()
  await page.getByLabel('Cards from').selectOption({ label: 'Law' })
  await page.getByRole('radio', { name: 'Missed', exact: true }).check()
  await page.getByLabel('Time').fill('23:59')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()
  await expect(page.getByText('Session planned')).toBeVisible()
  const planned = page.getByRole('region', { name: 'Planned sessions' })
  const row = planned.getByRole('link', { name: /Evening law/ })
  await expect(row).toContainText(/Every day at 11:59\sPM · Missed cards · Law · Next: (today|tomorrow) at 11:59\sPM/)

  // The next one shows on Today, as one calm line.
  await openToday(page)
  await expect(page.getByTestId('session-line')).toHaveText(
    /^Next session: Evening law, (today|tomorrow) at 11:59\sPM · Sessions$/,
  )
  await page.getByTestId('session-line').getByRole('link', { name: 'Sessions' }).click()

  // Edit: rename, switch to cramming.
  await page
    .getByRole('region', { name: 'Planned sessions' })
    .getByRole('link', { name: /Evening law/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Planned session' })).toBeVisible()
  await expect(page.getByLabel('Name')).toHaveValue('Evening law')
  await expect(page.getByRole('radio', { name: 'Missed', exact: true })).toBeChecked()
  await page.getByLabel('Name').fill('Night law')
  await page.getByRole('switch', { name: 'Count toward the schedule' }).uncheck()

  // Add to calendar: a weekly event with an alarm.
  // The name the app asks for; some browsers then rewrite it (WebKit on Linux turns spaces into '_').
  await page.evaluate(() => {
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) document.documentElement.dataset.downloadName = this.download
      click.call(this)
    }
  })
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Add to calendar' }).click()
  const file = await download
  expect(await page.evaluate(() => document.documentElement.dataset.downloadName)).toBe('Evening law.ics')
  expect(file.suggestedFilename()).toMatch(/^Evening[ _]law\.ics$/)
  const ics = await readFile((await file.path()) ?? '', 'utf8')
  expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU')
  expect(ics).toMatch(/DTSTART:\d{8}T235900/)
  expect(ics).toContain('SUMMARY:Evening law')
  expect(ics).toContain('DESCRIPTION:Missed cards · Law')
  expect(ics).toContain('BEGIN:VALARM')
  await expect(page.getByText('Calendar file saved. Open it to add the reminder.')).toBeVisible()

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Session planned')).toBeVisible()
  const renamed = page.getByRole('region', { name: 'Planned sessions' }).getByRole('link', { name: /Night law/ })
  await expect(renamed).toBeVisible()
  await expect(renamed.getByTestId('cramming')).toBeVisible()

  // Delete acts at once and offers Undo.
  await renamed.click()
  await page.getByRole('button', { name: 'Delete planned session' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()
  await expect(page.getByText('Planned session deleted')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Planned sessions' }).getByRole('link')).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(
    page.getByRole('region', { name: 'Planned sessions' }).getByRole('link', { name: /Night law/ }),
  ).toBeVisible()

  // Starting a planned session now: named after its plan.
  await page
    .getByRole('region', { name: 'Planned sessions' })
    .getByRole('link', { name: /Night law/ })
    .click()
  await page.getByRole('button', { name: 'Start now' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Night law' })).toBeVisible()
  await expect(page.getByTestId('cramming')).toBeVisible()
  expect(errors).toEqual([])
})

test('German, dark: sessions screens neither overflow nor fail axe', async ({ page }) => {
  const errors = watchErrors(page)
  await page.emulateMedia({ colorScheme: 'dark' })
  await harness.seed(page, { courses: [{ ...LAW, title: 'Vertragsrecht und Schuldrecht' }] })
  const query = '?locale=de'
  const problems: string[] = []
  const check = async (where: string) => {
    await settle(page)
    const overflow = await horizontalOverflow(page)
    if (overflow > 0) problems.push(`${where} overflows by ${overflow}px`)
    for (const v of await seriousViolations(page)) problems.push(`${where} ${v}`)
  }

  await openToday(page, query)
  await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE')
  await page.getByRole('link', { name: 'Neue Lerneinheit' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Neue Lerneinheit' })).toBeVisible()
  await page.getByRole('radio', { name: 'Alle', exact: true }).check()
  await expect(page.getByTestId('session-preview')).toHaveText('3 Karten in dieser Lerneinheit')
  await check('setup')
  await page.getByRole('button', { name: 'Lerneinheit starten' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Alle Karten' })).toBeVisible()
  await expect(page.getByTestId('cramming')).toHaveText('Pauken')
  await check('review')
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Antwort zeigen' }).click()
    await page.getByRole('button', { name: /^Nochmal,/ }).click()
  }
  await expect(page.getByRole('heading', { name: 'Lerneinheit abgeschlossen' })).toBeVisible()
  await check('summary')

  await page.goto(`./${query}#/sessions/plan/new`)
  await expect(page.getByRole('heading', { level: 1, name: 'Neue geplante Lerneinheit' })).toBeVisible()
  await page.getByLabel('Name').fill('Abendwiederholung Vertragsrecht')
  await page.getByLabel('Karten aus').selectOption({ label: 'Vertragsrecht und Schuldrecht' })
  await check('plan')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Lerneinheiten' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Vergessene noch einmal üben/ })).toBeVisible()
  await check('sessions')
  expect(problems).toEqual([])
  expect(errors).toEqual([])
})
