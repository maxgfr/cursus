import { expect, type Page, test } from '@playwright/test'
import { seriousViolations, settle, watchErrors } from './support/page.ts'

test.use({ serviceWorkers: 'block' })

const COURSE = 'Demo: Cell biology'

/** From the onboarding, as a new student would: nothing exists until the demo is asked for. */
async function createDemo(page: Page, query = '', action = 'Try a demo course', title = COURSE) {
  await page.goto(`./${query}#/onboarding`)
  await page.getByRole('button', { name: action }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  // The course screen slides in: let it come to rest before tapping its controls.
  await settle(page)
}

/** Hash navigation inside the running page (no reload): the query (`?locale=…`) stays. */
async function go(page: Page, hash: string, heading: string | RegExp) {
  await page.evaluate((h) => {
    location.hash = h
  }, hash)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
}

/** The hash route of the screen on display. */
const route = (page: Page): string => new URL(page.url()).hash

async function showSources(page: Page, label = 'Sources') {
  const tab = page.getByRole('radio', { name: label })
  await tab.check()
  await expect(tab).toBeChecked()
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test('Demo: Today comes alive (due cards, exam, next session, proposed questions); subsets two levels deep', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await createDemo(page)
  const course = route(page)
  // The course root: its two subsets, the questions waiting, an exam three weeks away.
  const main = page.getByRole('main')
  await expect(page.getByTestId('place-meta')).toContainText('16 cards')
  await expect(page.getByTestId('place-meta')).toContainText('21 days left')
  await expect(main.getByRole('link', { name: /^Membranes/ })).toContainText('8 cards')
  await expect(main.getByRole('link', { name: /^Organelles/ })).toContainText('6 cards')
  await expect(page.getByTestId('course-drafts')).toContainText('5 suggested cards')
  expect(await seriousViolations(page)).toEqual([])

  // A subset, then one of its own.
  await main.getByRole('link', { name: /^Membranes/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Membranes' })).toBeVisible()
  await expect(main.getByRole('link', { name: /^Structure/ })).toContainText('2 cards')
  await main.getByRole('link', { name: /^Transport/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Transport' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: /./ }).getByRole('link', { name: 'Membranes' })).toBeVisible()
  await expect(main.getByRole('link', { name: 'What does Fick’s law say?' })).toBeVisible()

  // Today: three cards due (one being relearned, one overdue, the new illustrated one), led by the exam.
  await go(page, '#/', 'Today')
  await expect(page.getByRole('heading', { level: 2, name: '3 cards due today' })).toBeVisible()
  await expect(page.getByTestId('exam-lead')).toHaveText(`incl. 3 in ${COURSE} · 21 days left`)
  await expect(page.getByTestId('session-line')).toHaveText(/^Next session: Weekly review, .+ · Sessions$/)
  await expect(page.getByTestId('drafts-line')).toContainText(`5 cards suggested from ${COURSE}`)
  await expect(main.getByRole('link', { name: new RegExp(COURSE) })).toContainText('3 due')
  expect(await seriousViolations(page)).toEqual([])

  // « To review »: the proposed questions, grouped by slide; a slide's citation opens it in the deck.
  await page.getByTestId('drafts-line').getByRole('link').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Suggested cards' })).toBeVisible()
  for (const slide of ['Slide 2', 'Slide 3', 'Slide 4'])
    await expect(main.getByRole('link', { name: slide, exact: true })).toBeVisible()
  await expect(main.getByText('How thick is the plasma membrane?')).toBeVisible()
  expect(await seriousViolations(page)).toEqual([])
  await main.getByRole('link', { name: 'Slide 2', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Lecture 3: Membranes and transport' })).toBeVisible()
  await expect(page.getByText('Cited: Slide 2')).toBeVisible()
  await expect(page.locator('li[aria-current="location"]')).toContainText('The plasma membrane')
  await expect(page.locator('li[aria-current="location"]')).toContainText('Draw the bilayer on the board')

  // An ordinary course: to the trash with everything it planned, and back.
  await go(page, course, COURSE)
  await page.getByRole('button', { name: 'Course settings' }).click()
  // Asked, then confirmed.
  await page.getByRole('button', { name: 'Delete course' }).click()
  await page.getByRole('button', { name: 'Delete course' }).click()
  await go(page, '#/', 'Today')
  await expect(page.getByTestId('session-line')).toHaveCount(0)
  await expect(page.getByTestId('drafts-line')).toHaveCount(0)
  await go(page, '#/trash', 'Trash')
  await page.getByRole('button', { name: `Restore ${COURSE}` }).click()
  await go(page, '#/', 'Today')
  await expect(page.getByRole('heading', { level: 2, name: '3 cards due today' })).toBeVisible()
  await expect(page.getByTestId('session-line')).toBeVisible()
  expect(errors).toEqual([])
})

test('Demo: a note with maths, a slide deck read slide by slide, photos in the gallery and the viewer', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await createDemo(page)
  const course = route(page)
  const main = page.getByRole('main')

  // The note: headings, a list, a table and maths, rendered; its attached photo below.
  await showSources(page)
  await main.getByRole('link', { name: /^Cell biology: the essentials/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Cell biology: the essentials' })).toBeVisible()
  await page.getByRole('button', { name: 'Preview' }).click()
  // Two displayed formulas and six inline ones.
  await expect(main.locator('.math-block .katex')).toHaveCount(2)
  await expect(main.locator('.math-block .katex').first()).toBeVisible()
  await expect(main.locator('.katex')).toHaveCount(8)
  await expect(main.getByRole('table')).toContainText('Prokaryote')
  await expect(main.getByRole('heading', { name: 'Why cells stay small' })).toBeVisible()
  await expect(main.getByRole('img', { name: /Onion skin under the microscope/ }).first()).toBeVisible()
  expect(await seriousViolations(page)).toEqual([])

  // The slides, from their own stored file: four, with speaker notes and a picture; no AI needed to read them.
  await go(page, course, COURSE)
  await main.getByRole('link', { name: /^Membranes/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Membranes' })).toBeVisible()
  await showSources(page)
  await main.getByRole('link', { name: /^Lecture 3: Membranes and transport/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Lecture 3: Membranes and transport' })).toBeVisible()
  await expect(page.getByText('4 slides')).toBeVisible()
  const slides = main.locator('ol > li[id^="unit-"]')
  await expect(slides).toHaveCount(4)
  await expect(slides.nth(1)).toContainText('The plasma membrane')
  await expect(slides.nth(1)).toContainText('A phospholipid bilayer, about 7–8 nm thick')
  await expect(
    slides.nth(1).getByRole('img', { name: 'Phospholipid bilayer crossed by a channel protein' }),
  ).toBeVisible()
  await expect(slides.nth(2)).toContainText('Facilitated diffusion')
  expect(await seriousViolations(page)).toEqual([])
  // Making questions from it needs an AI model: the way to set one up is offered, nothing is called.
  await main.getByRole('link', { name: 'Create cards' }).first().click()
  await expect(page.getByRole('link', { name: 'Open AI settings' })).toBeVisible()

  // The gallery: both photos, captioned; the viewer shows one full size.
  await go(page, course, COURSE)
  await showSources(page)
  await main.getByRole('link', { name: /^Photos/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible()
  await expect(page.getByTestId('photo-tile')).toHaveCount(2)
  expect(await seriousViolations(page)).toEqual([])
  await page.getByRole('link', { name: /Animal cell sketched in class/ }).click()
  await expect(page.getByTestId('viewer-photo')).toHaveAttribute('alt', /Animal cell sketched in class/)
  await expect
    .poll(() => page.getByTestId('viewer-photo').evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBe(640)
  expect(errors).toEqual([])
})

test('Demo: a review with an illustrated card, the sessions history relaunched, stats with cramming', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await createDemo(page)

  // Today's three cards; the new one shows its photo.
  await go(page, '#/', 'Today')
  await page.getByRole('button', { name: /^Start/ }).click()
  let illustrated = 0
  for (let i = 0; i < 3; i++) {
    const question = page.getByTestId('question')
    await expect(question).toBeVisible()
    await expect(page.getByTestId('remaining')).toHaveText(`${3 - i} left`)
    const photo = question.getByRole('img', { name: 'Animal cell sketched in class, with A and B labelled' })
    if ((await photo.count()) > 0) {
      illustrated++
      await expect(question).toContainText('Which organelle is labelled A on this sketch?')
      await expect.poll(() => photo.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      expect(await seriousViolations(page)).toEqual([])
    }
    await page.getByRole('button', { name: 'Show answer' }).click()
    await page.getByRole('button', { name: /^Good,/ }).click()
  }
  expect(illustrated).toBe(1)

  // The history: a counted session and a cramming one, each with a missed card to relaunch.
  await go(page, '#/sessions', 'Sessions')
  const past = page.getByRole('region', { name: 'Past sessions' })
  await expect(past.getByTestId('cramming')).toHaveCount(1)
  await expect(past.getByRole('button', { name: /^Go over the forgotten ones/ })).toHaveCount(2)
  await expect(page.getByRole('region', { name: 'Planned sessions' }).getByRole('link')).toContainText('Weekly review')
  expect(await seriousViolations(page)).toEqual([])
  await past
    .getByRole('button', { name: /^Go over the forgotten ones/ })
    .last()
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Forgotten cards' })).toBeVisible()
  await expect(page.getByTestId('cramming')).toBeVisible()
  await expect(page.getByTestId('remaining')).toHaveText('1 left')
  await expect(page.getByTestId('question')).toContainText('What does Fick’s law say?')

  // Statistics: two weeks of reviews, the retention, and the cramming apart.
  await go(page, '#/stats', 'Statistics')
  await expect(page.getByTestId('cramming-tile')).toContainText('5 reviews')
  await expect(page.getByTestId('cramming-tile')).toContainText(/80(\.0)?% recalled/)
  await expect(page.getByTestId('retention')).toHaveText(/^\d+(\.\d)?%$/)
  expect(await seriousViolations(page)).toEqual([])
  expect(errors).toEqual([])
})

test('German, dark: the demo course fits every screen and passes axe', async ({ page }) => {
  const errors = watchErrors(page)
  await page.emulateMedia({ colorScheme: 'dark' })
  const query = '?locale=de'
  await createDemo(page, query, 'Demokurs ausprobieren', 'Demo: Zellbiologie')
  await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE')
  const problems: string[] = []
  const check = async (where: string) => {
    await settle(page)
    const overflow = await horizontalOverflow(page)
    if (overflow > 0) problems.push(`${where} overflows by ${overflow}px`)
    for (const v of await seriousViolations(page)) problems.push(`${where} ${v}`)
  }
  const main = page.getByRole('main')
  const course = route(page)
  await check('course')
  await main.getByRole('link', { name: /^Membranen/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Membranen' })).toBeVisible()
  await check('subset')
  await showSources(page, 'Quellen')
  await main.getByRole('link', { name: /^Vorlesung 3: Membranen und Transport/ }).click()
  await expect(page.getByText('4 Folien')).toBeVisible()
  await check('deck')
  await go(page, course, 'Demo: Zellbiologie')
  await showSources(page, 'Quellen')
  await main.getByRole('link', { name: /^Zellbiologie: das Wichtigste/ }).click()
  await page.getByRole('button', { name: 'Vorschau' }).click()
  await expect(main.locator('.katex').first()).toBeVisible()
  await check('note')
  await go(page, course, 'Demo: Zellbiologie')
  await showSources(page, 'Quellen')
  await main.getByRole('link', { name: /^Fotos/ }).click()
  await expect(page.getByTestId('photo-tile')).toHaveCount(2)
  await check('photos')
  for (const [hash, heading] of [
    ['#/', 'Heute'],
    ['#/inbox', 'Vorgeschlagene Karten'],
    ['#/sessions', 'Lerneinheiten'],
    ['#/stats', 'Statistik'],
  ] as const) {
    await go(page, hash, heading)
    await check(hash)
  }
  await expect(page.getByTestId('cramming-tile')).toBeVisible()
  await go(page, '#/', 'Heute')
  await page.getByRole('button', { name: /^Starten/ }).click()
  await expect(page.getByTestId('question')).toBeVisible()
  await check('review')
  expect(problems).toEqual([])
  expect(errors).toEqual([])
})

test('German at 375px: the statistics fit, no word in a tile and no button past the screen', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await createDemo(page, '?locale=de', 'Demokurs ausprobieren', 'Demo: Zellbiologie')
  await go(page, '#/stats', 'Statistik')
  await expect(page.getByTestId('cramming-tile')).toBeVisible()
  await settle(page)
  // Clipped content does not scroll the page: every box is measured, not only the page's scroll width.
  const spills = await page.evaluate(() => {
    const out: string[] = []
    const screen = document.documentElement.clientWidth
    const name = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}"`
    for (const el of Array.from(document.querySelectorAll('main *'))) {
      const box = el.getBoundingClientRect()
      if (box.width > 0 && box.right > screen + 0.5) out.push(`${name(el)} ends at ${Math.round(box.right)}px`)
    }
    for (const tile of Array.from(document.querySelectorAll('main section[aria-label] > div'))) {
      const style = getComputedStyle(tile)
      const inner = tile.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
      for (const part of Array.from(tile.children)) {
        const width = part.getBoundingClientRect().width
        if (width > inner + 0.5) out.push(`${name(part)} is ${Math.round(width)}px in a ${Math.round(inner)}px tile`)
      }
    }
    return out
  })
  expect(spills).toEqual([])
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  expect(errors).toEqual([])
})
