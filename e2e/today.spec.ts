import { expect, type Page, test } from '@playwright/test'
import { createHarness } from './support/harness.ts'
import { seriousViolations, watchErrors } from './support/page.ts'

test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

const DAY = 86_400_000

/** The local date `days` study days from now: a study day starts at 04:00, as in the app. */
function isoIn(page: Page, days: number): Promise<string> {
  return page.evaluate((n) => {
    const d = new Date()
    if (d.getHours() < 4) d.setDate(d.getDate() - 1)
    d.setDate(d.getDate() + n)
    const pad = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }, days)
}

async function openToday(page: Page) {
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
}

async function answerGood(page: Page) {
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: /^Good,/ }).click()
}

test('Today lists the courses with work, most urgent first, and reviews one course’s share in one tap', async ({
  page,
}) => {
  const errors = watchErrors(page)
  const now = Date.now()
  await harness.seed(page, {
    courses: [
      {
        title: 'Biology',
        cards: [
          { front: 'What is a cell?', back: 'The unit of life' },
          { front: 'What is a gene?', back: 'A unit of heredity' },
        ],
      },
      {
        title: 'Law',
        cards: [
          // Answered Easy long ago: overdue for weeks.
          {
            front: 'What is consideration?',
            back: 'Something of value exchanged',
            reviews: [{ rating: 4, at: now - 40 * DAY }],
          },
          { front: 'What is an offer?', back: 'A promise open to acceptance' },
        ],
      },
      { title: 'History', cards: [{ front: 'When did Rome fall?', back: 'In 476' }] },
      // Nothing to review in it today: not listed.
      {
        title: 'Music',
        cards: [{ front: 'What is a fugue?', back: 'A piece built on one theme', reviews: [{ rating: 4, at: now }] }],
      },
    ],
  })
  // History's exam is in three days.
  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /^History/ })
    .click()
  await page.getByRole('button', { name: 'Course settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Course settings' })
  await settings.getByLabel('Exam date').fill(await isoIn(page, 3))
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings).toBeHidden()

  await openToday(page)
  await expect(page.getByRole('heading', { level: 2, name: '5 cards due today' })).toBeVisible()
  // The exam first, then the most behind, then the new cards; each says why, and its share.
  const list = page.getByRole('region', { name: 'By course' })
  const rows = list.getByRole('button')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('History')
  await expect(rows.nth(0).getByTestId('course-reason')).toHaveText(/^Exam on [A-Z][a-z]+day$/)
  await expect(rows.nth(0)).toContainText('1 card · Review this course')
  await expect(rows.nth(1)).toContainText('Law')
  await expect(rows.nth(1).getByTestId('course-reason')).toHaveText('1 overdue')
  await expect(rows.nth(1)).toContainText('2 cards · Review this course')
  await expect(rows.nth(2)).toContainText('Biology')
  await expect(rows.nth(2).getByTestId('course-reason')).toHaveText('2 new')
  await expect(rows.nth(2)).toContainText('2 cards · Review this course')
  await expect(list).toContainText('Nothing else today')
  // Said once: the row names History's exam, the total does not repeat it.
  await expect(page.getByTestId('exam-lead')).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('button', { name: /^Music/ })).toHaveCount(0)
  // Today keeps to today: the full course list is on the Courses tab, « New session » on Practice.
  await expect(page.getByRole('main').getByRole('button', { name: /New session/ })).toHaveCount(0)
  expect(await seriousViolations(page)).toEqual([])

  // « Review this course »: Law's share and nothing else, the overdue card first.
  await rows.nth(1).click()
  await expect(page.getByTestId('remaining')).toHaveText('2 left')
  await expect(page.getByTestId('question')).toContainText('What is consideration?')
  await answerGood(page)
  await expect(page.getByTestId('question')).toContainText('What is an offer?')
  await answerGood(page)
  await page.getByRole('button', { name: 'Close' }).click()

  // Law's done for now (its new card is on a learning step): the others stay, in the same order.
  await expect(page.getByRole('heading', { level: 2, name: '3 cards due today' })).toBeVisible()
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('History')
  await expect(rows.nth(1)).toContainText('Biology')

  // The main action reviews everything due in that order: the exam's course first.
  await page.getByRole('button', { name: /^Review/ }).click()
  await expect(page.getByTestId('remaining')).toHaveText('3 left')
  await expect(page.getByTestId('question')).toContainText('When did Rome fall?')
  expect(errors).toEqual([])
})
