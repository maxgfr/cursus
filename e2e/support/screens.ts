import { expect, type Page } from '@playwright/test'
import type { Harness } from './harness.ts'

const DAY = 86_400_000

/** Seeds a small library (one course, a note, a due card with a history, a new card) for screen sweeps. */
export async function seedLibrary(harness: Harness, page: Page, title = 'Zellbiologie'): Promise<void> {
  const now = Date.now()
  await harness.seed(page, {
    courses: [
      {
        title,
        notes: [{ title: 'Mitochondrien', body: 'Mitochondrien erzeugen ATP.' }],
        cards: [
          {
            front: 'Kraftwerk der Zelle?',
            back: 'Das Mitochondrium',
            reviews: [
              { rating: 3, at: now - 30 * DAY },
              { rating: 1, at: now - 20 * DAY },
              { rating: 3, at: now - 19 * DAY },
            ],
          },
          { front: 'Ort der Photosynthese?', back: 'Der Chloroplast' },
        ],
      },
    ],
  })
}

/**
 * Every main screen's hash, the library ones resolved from the seeded course: reached through the app's own links.
 * `query` keeps a `?locale=` override on the way.
 */
export async function mainScreens(page: Page, query = ''): Promise<string[]> {
  await page.goto(`./${query}#/courses`)
  const course = page.getByRole('main').locator('a[href*="#/course/"]').first()
  await expect(course).toBeVisible()
  const courseHash = hashOf(await course.getAttribute('href'))
  await page.goto(`./${query}${courseHash}`)
  const card = page.getByRole('main').locator('a[href*="#/card/"]').first()
  await expect(card).toBeVisible()
  const cardHash = hashOf(await card.getAttribute('href'))
  await page.getByRole('radio').nth(1).check()
  const source = page.getByRole('main').locator('a[href*="#/source/"]').first()
  await expect(source).toBeVisible()
  const sourceHash = hashOf(await source.getAttribute('href'))
  return [
    '#/',
    '#/courses',
    courseHash,
    cardHash,
    sourceHash,
    `#/history/${sourceHash.slice('#/source/'.length)}`,
    '#/review',
    '#/understand',
    '#/generate',
    '#/quiz',
    '#/search',
    '#/stats',
    '#/trash',
    '#/onboarding',
    '#/settings',
    '#/settings/general',
    '#/settings/review',
    '#/settings/ai',
    '#/settings/sync',
    '#/settings/seal',
    '#/settings/pair',
    '#/settings/data',
    '#/settings/recovery',
    '#/settings/diagnostic',
  ]
}

function hashOf(href: string | null): string {
  const i = href?.indexOf('#') ?? -1
  if (!href || i < 0) throw new Error(`no hash route in ${href}`)
  return href.slice(i)
}

/** Opens a screen and waits for its heading and the end of its transitions. */
export async function openScreen(page: Page, query: string, hash: string): Promise<void> {
  await page.goto(`./${query}${hash}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}
