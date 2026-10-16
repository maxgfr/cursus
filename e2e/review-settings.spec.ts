import { expect, type Page, test } from '@playwright/test'
import { createHarness, type SeedCard } from './support/harness.ts'
import { watchErrors } from './support/page.ts'

// « Schedule », Anki-style: the recommended settings by default, the buttons' waits shown as they are changed, the
// review then following them; a hard card suspended with its grade when asked, Undo taking both back.
test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

const DAY = 86_400_000

/** A card forgotten `lapses` times, the last long enough ago to be due today. */
function lapsed(now: number, lapses: number): SeedCard['reviews'] {
  const start = now - 400 * DAY
  const reviews: NonNullable<SeedCard['reviews']> = [{ rating: 4, at: start }]
  for (let i = 1; i <= lapses; i++) {
    reviews.push({ rating: 1, at: start + i * 10 * DAY })
    reviews.push({ rating: 3, at: start + i * 10 * DAY + 600_000 })
  }
  return reviews
}

async function openSchedule(page: Page) {
  await page.goto('./#/settings/review')
  await expect(page.getByRole('heading', { level: 1, name: 'Schedule' })).toBeVisible()
}

async function reveal(page: Page) {
  await page.goto('./#/review')
  await expect(page.getByTestId('question')).toBeVisible()
  await page.getByRole('button', { name: /Show answer/ }).click()
  await expect(page.getByTestId('answer')).toBeVisible()
}

test('the recommended settings and their waits; steps of 2m 15m in the preview, then in review; Restore', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await harness.seed(page, { courses: [{ title: 'Law', cards: [{ front: 'Offer?', back: 'A proposal' }] }] })
  await openSchedule(page)
  const preview = page.getByTestId('review-preview')
  await expect(preview).toContainText('Again 1 min · Hard 6 min · Good 10 min · Easy 8 days')
  await expect(preview).toContainText('Again 10 min · Hard 7 days · Good 9 days · Easy 13 days')
  const save = page.getByRole('button', { name: 'Save' })
  await expect(save).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Restore recommended settings' })).toBeDisabled()

  // Not a step: said, and nothing can be saved.
  const steps = page.getByLabel('Learning steps', { exact: true })
  await expect(steps).toHaveValue('1m 10m')
  await steps.fill('10')
  await expect(
    page.getByText('Write up to 10 steps such as 1m 10m, each from 1 minute to 1 day.').first(),
  ).toBeVisible()
  await expect(save).toBeDisabled()
  await steps.fill('2m 15m')
  await expect(preview).toContainText('Again 2 min · Hard 9 min · Good 15 min')
  await save.click()
  await expect(page.getByText(/^Saved\./)).toBeVisible()

  // Review follows: the new card's Again brings it back in 2 minutes.
  await reveal(page)
  await expect(page.getByRole('button', { name: 'Again, next review in 2 min' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Good, next review in 15 min' })).toBeVisible()

  // Back to the recommended settings: filled in, then saved.
  await openSchedule(page)
  await expect(page.getByLabel('Learning steps', { exact: true })).toHaveValue('2m 15m')
  await page.getByRole('button', { name: 'Restore recommended settings' }).click()
  await expect(page.getByLabel('Learning steps', { exact: true })).toHaveValue('1m 10m')
  await expect(page.getByLabel('New cards per day')).toHaveValue('20')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/^Saved\./)).toBeVisible()
  await reveal(page)
  await expect(page.getByRole('button', { name: 'Again, next review in 1 min' })).toBeVisible()
  expect(errors).toEqual([])
})

test('a card forgotten once too often is suspended with its grade when asked; Undo takes both back', async ({
  page,
}) => {
  const errors = watchErrors(page)
  const now = Date.now()
  await harness.seed(page, {
    courses: [
      { title: 'Geography', cards: [{ front: 'Capital of Australia?', back: 'Canberra', reviews: lapsed(now, 7) }] },
    ],
  })
  await openSchedule(page)
  await page.getByRole('radio', { name: 'Is suspended' }).check({ force: true })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/^Saved\./)).toBeVisible()

  await reveal(page)
  await page.getByRole('button', { name: /^Again, next review in/ }).click()
  const toast = page.getByRole('status').filter({ hasText: 'Suspended: this card keeps slipping' })
  await expect(toast).toBeVisible()
  // Undo takes the grade and the suspension back: the card is there again, its answer shown.
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByTestId('answer')).toContainText('Canberra')
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 2, name: '1 card due today' })).toBeVisible()

  // Graded again: suspended for good, out of today's reviews.
  await reveal(page)
  await page.getByRole('button', { name: /^Again, next review in/ }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Suspended: this card keeps slipping' })).toBeVisible()
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 2, name: '1 card due today' })).toHaveCount(0)
  expect(errors).toEqual([])
})
