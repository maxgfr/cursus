import { expect, test } from '@playwright/test'
import { createCourse, go, isPhone, typeInto, watchErrors } from './support/page.ts'

test.use({ serviceWorkers: 'block' })

// The whole study loop, in English, on every project of the matrix (Mac Chrome, Mac Safari, iPhone, iPad):
// a course, a note, two cards, a review session, search, statistics, and everything still there after a reload.
test('functional journey: course, note, cards, review, search, stats, reload', async ({ page }, info) => {
  test.setTimeout(90_000)
  const phone = isPhone(info.project.name)
  const errors = watchErrors(page)
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Start with a course' })).toBeVisible()

  await createCourse(page, 'Cell biology')
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByRole('button', { name: 'Write a note' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled note' })).toBeVisible()
  await typeInto(page, 'Source', 'Mitochondria make ATP. Chloroplasts capture light.')
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Cell biology' })).toBeVisible()

  const cards: [string, string][] = [
    ['Powerhouse of the cell?', 'The mitochondrion'],
    ['Site of photosynthesis?', 'The chloroplast'],
  ]
  for (const [front, back] of cards) {
    await page.getByRole('radio', { name: 'Cards' }).check()
    await page.getByRole('button', { name: 'New card' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Card' })).toBeVisible()
    await typeInto(page, 'Front', front)
    await typeInto(page, 'Back', back)
    await page.getByRole('link', { name: 'Back' }).click()
    await expect(
      page.getByRole('main').getByRole('link', { name: new RegExp(front.replace('?', '\\?')) }),
    ).toBeVisible()
  }

  // Today offers the two new cards; the session reviews both.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Today' }).click()
  await expect(page.getByRole('heading', { name: 'Due today' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: /Cell biology/ })).toContainText('2 due')
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible()
  for (let i = 0; i < 2; i++) {
    await expect(page.getByRole('progressbar', { name: `${i} of 2` })).toBeVisible()
    if (phone) await page.getByRole('button', { name: /Show answer/ }).tap()
    else await page.keyboard.press('Space')
    await expect(page.getByTestId('answer')).toBeVisible()
    const good = page.getByRole('button', { name: /^Good, next review in/ })
    if (phone) await good.tap()
    else await good.click()
  }
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('You reviewed 2 cards.')).toBeVisible()

  // Search finds a card and a note by their words.
  await page.goto('./#/search')
  await page.getByRole('searchbox').fill('photosynthesis')
  await expect(page.getByRole('main').getByRole('link', { name: /Site of photosynthesis\?/ })).toBeVisible()
  await page.getByRole('searchbox').fill('chloroplasts')
  await expect(page.getByRole('main').getByRole('link', { name: /Untitled note/ })).toBeVisible()

  await go(page, '#/stats', 'Statistics')
  await expect(page.getByText('2 reviews').first()).toBeVisible()

  // Everything went through the local log: a reload shows the same library, nothing left to review.
  await page.reload()
  await go(page, '#/', 'Today')
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible()
  await page
    .getByRole('main')
    .getByRole('link', { name: /Cell biology/ })
    .click()
  for (const [front] of cards)
    await expect(
      page.getByRole('main').getByRole('link', { name: new RegExp(front.replace('?', '\\?')) }),
    ).toBeVisible()
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page
    .getByRole('main')
    .getByRole('link', { name: /Untitled note/ })
    .click()
  await expect(page.getByRole('textbox', { name: 'Source' })).toContainText('Mitochondria make ATP.')
  expect(errors).toEqual([])
})
