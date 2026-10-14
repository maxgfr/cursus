import { expect, test } from '@playwright/test'
import { createHarness } from './support/harness.ts'
import { watchErrors } from './support/page.ts'

test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

const BUDGET_MS = 1_500

// The budget is for the phone: a large library (10,000 cards, 200,000 reviews) opens and Today is ready.
test('10,000 cards and 200,000 reviews: Today is ready in under 1.5 s', async ({ page }, info) => {
  test.skip(info.project.name !== 'webkit-iphone', 'the budget is set for the iPhone')
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  await harness.seed(page, { bulk: { courses: 10, cardsPerCourse: 1_000, reviewsPerCard: 20 } })

  // Records, in the page, the moment Today shows the due count and the course list (no polling delay).
  await page.addInitScript(() => {
    const w = window as Window & { __ready?: number }
    const check = () => {
      if (w.__ready !== undefined) return
      const due = [...document.querySelectorAll('h2')].some((h) => /cards due today$/.test(h.textContent ?? ''))
      const course = [...document.querySelectorAll('main a')].some((a) => a.textContent?.includes('Course 10'))
      if (due && course) w.__ready = performance.now()
    }
    new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true })
  })
  // Warm the HTTP cache once (the first-ever launch downloads the app), then measure launches.
  await page.goto('./#/')
  await expect(page.getByRole('heading', { name: /cards due today$/ })).toBeVisible({ timeout: 60_000 })
  const timings: number[] = []
  for (let i = 0; i < 3; i++) {
    await page.reload()
    await expect(page.getByRole('heading', { name: /cards due today$/ })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('main').getByRole('link', { name: /Course 10/ })).toBeVisible()
    timings.push(
      await page.evaluate(() => (window as Window & { __ready?: number }).__ready ?? Number.POSITIVE_INFINITY),
    )
  }
  const median = [...timings].sort((a, b) => a - b)[1] ?? Number.POSITIVE_INFINITY
  console.log(`perf: Today ready after ${timings.map((t) => Math.round(t)).join(' / ')} ms`)
  expect(median).toBeLessThan(BUDGET_MS)
  expect(errors).toEqual([])
})
