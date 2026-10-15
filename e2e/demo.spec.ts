import { expect, type Page, test } from '@playwright/test'
import { literal, translator } from './support/catalog.ts'
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

/**
 * What in the main area is cut off: a box that ends past the box that clips it (or past the screen), unless it sits
 * in a box that scrolls sideways (a code block, a wide table, a formula). A frame that clips (`overflow: clip`)
 * never grows the page's scroll width: measuring each box is the only way to see it.
 */
async function cutOff(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const screen = document.documentElement.clientWidth
    const name = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}"`
    for (const el of Array.from(document.querySelectorAll('main *'))) {
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      let limit = screen
      // Visually hidden on purpose (a formula's MathML, a label for screen readers): clipped to nothing.
      let hidden = false
      for (let up: Element | null = el; up !== null && !hidden; up = up.parentElement) {
        const style = getComputedStyle(up)
        hidden = style.clip.startsWith('rect') || style.clipPath !== 'none'
      }
      if (hidden) continue
      for (let up = el.parentElement; up !== null; up = up.parentElement) {
        const overflow = getComputedStyle(up).overflowX
        if (overflow === 'auto' || overflow === 'scroll') {
          limit = Number.POSITIVE_INFINITY
          break
        }
        if (overflow === 'hidden' || overflow === 'clip') {
          limit = Math.min(limit, up.getBoundingClientRect().right)
          break
        }
      }
      if (box.right > limit + 1)
        out.push(`${name(el)} ends at ${Math.round(box.right)}px, cut at ${Math.round(limit)}px`)
    }
    return out
  })
}

test('Demo: Today comes alive (due cards, exam, next session, proposed questions); subsets two levels deep', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await createDemo(page)
  const course = route(page)
  // The course root: its two subsets (the first with its own midterm), the questions waiting, an exam in three weeks.
  const main = page.getByRole('main')
  await expect(page.getByTestId('place-meta')).toContainText('16 cards')
  await expect(page.getByTestId('place-meta')).toContainText('21 days left')
  await expect(main.getByRole('link', { name: /^Membranes/ })).toContainText('8 cards')
  await expect(main.getByRole('link', { name: /^Membranes/ })).toContainText('10 days left')
  await expect(main.getByRole('link', { name: /^Organelles/ })).toContainText('6 cards')
  await expect(page.getByTestId('course-drafts')).toContainText('7 suggested cards')
  expect(await seriousViolations(page)).toEqual([])

  // A subset, then one of its own.
  await main.getByRole('link', { name: /^Membranes/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Membranes' })).toBeVisible()
  await expect(main.getByRole('link', { name: /^Structure/ })).toContainText('2 cards')
  await main.getByRole('link', { name: /^Transport/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Transport' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: /./ }).getByRole('link', { name: 'Membranes' })).toBeVisible()
  await expect(main.getByRole('link', { name: 'What does Fick’s law say?' })).toBeVisible()

  // Today: three cards due (one being relearned, one overdue, the new illustrated one), led by the nearest exam:
  // the midterm on membranes, which holds two of them.
  await go(page, '#/', 'Today')
  await expect(page.getByRole('heading', { level: 2, name: '3 cards due today' })).toBeVisible()
  await expect(page.getByTestId('exam-lead')).toHaveText('incl. 2 in Membranes · 10 days left')
  await expect(page.getByTestId('session-line')).toHaveText(/^Next session: Weekly review, .+ · Sessions$/)
  await expect(page.getByTestId('drafts-line')).toContainText(`7 cards suggested from ${COURSE}`)
  await expect(main.getByRole('link', { name: new RegExp(COURSE) })).toContainText('3 due')
  expect(await seriousViolations(page)).toEqual([])

  // « To review »: the proposed questions, grouped by slide, by section of the handout, and on the sketch; a
  // slide's citation opens it in the deck.
  await page.getByTestId('drafts-line').getByRole('link').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Suggested cards' })).toBeVisible()
  for (const unit of ['Slide 2', 'Slide 3', 'Slide 4', 'Section 3'])
    await expect(main.getByRole('link', { name: unit, exact: true })).toBeVisible()
  await expect(main.getByText('What happens to a red blood cell in 3 % NaCl?')).toBeVisible()
  await expect(main.getByText('Which organelle is labelled B on the sketch?')).toBeVisible()
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
  // The demo's own trashed subset waits there too.
  await expect(page.getByRole('button', { name: `Restore ${COURSE} › Last year’s notes` })).toBeVisible()
  await page.getByRole('button', { name: `Restore ${COURSE}`, exact: true }).click()
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
  // Rendered in the editor itself (nothing to switch to), which draws what is near the screen: the note in view.
  await main.locator('.cm-content').evaluate((el) => el.scrollIntoView({ block: 'center' }))
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
  // Making questions from it needs an AI model: without one nothing of the AI shows, nothing is called.
  await page.waitForLoadState('networkidle')
  await expect(main.getByRole('button', { name: 'Create cards' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open AI settings' })).toHaveCount(0)

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

  // The history: a counted session started from the weekly plan and a cramming one, each with a missed card to
  // relaunch; the cramming's missed card already gone over once. Two plans, one a practice of the midterm's subset.
  await go(page, '#/sessions', 'Practice')
  const past = page.getByRole('region', { name: 'Past sessions' })
  await expect(past.getByTestId('cramming')).toHaveCount(2)
  await expect(past.getByRole('button', { name: /^Go over the forgotten ones/ })).toHaveCount(2)
  await expect(past.getByText('Weekly review', { exact: true })).toBeVisible()
  const planned = page.getByRole('region', { name: 'Planned sessions' })
  await expect(planned.getByRole('link', { name: /^Weekly review/ })).toBeVisible()
  await expect(planned.getByRole('link', { name: /^Before the midterm/ }).getByTestId('cramming')).toBeVisible()
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
  await expect(page.getByTestId('cramming-tile')).toContainText('6 reviews')
  await expect(page.getByTestId('cramming-tile')).toContainText(/83(\.3)?% recalled/)
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
    ['#/sessions', 'Üben'],
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

/** A cloze as a list shows it: its sentence, every blank answered. */
const sentence = (cloze: string): string => cloze.replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/g, '$1')

for (const locale of ['en', 'de', 'fr'] as const) {
  test(`Demo in ${locale}: every feature is there, in the language, and reachable`, async ({ page }) => {
    test.slow()
    const t = translator(locale)
    const errors = watchErrors(page)
    const title = t('today.demoCourse')
    await createDemo(page, locale === 'en' ? '' : `?locale=${locale}`, t('today.demoAction'), title)
    const course = route(page)
    const main = page.getByRole('main')
    const row = (name: string) => main.getByRole('link', { name: new RegExp(`^${literal(name)}`) })
    const open = async (name: string, heading = name) => {
      await row(name).click()
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
      await settle(page)
    }
    const tab = (key: string) => showSources(page, t(key))

    // The course: its cards, its exam in three weeks; two subsets, the first with its own midterm; one in the trash.
    await expect(page.getByTestId('place-meta')).toContainText(t('course.cardCount', { count: 16 }))
    await expect(page.getByTestId('place-meta')).toContainText(t('today.examCountdown', { count: 21 }))
    await expect(row(t('today.demoSecMembranes'))).toContainText(t('today.examCountdown', { count: 10 }))
    await expect(main.getByText(t('course.restoreItem', { name: t('today.demoSecOld') }))).toBeVisible()
    // A question-and-answer card.
    await open(t('today.demoQ01'), t('common.cardTitle'))
    await expect(page.getByRole('radio', { name: t('course.kindBasic') })).toBeChecked()
    await expect(main.getByText(t('today.demoA01'))).toBeVisible()

    // The course's sources: the note (its history), the syllabus kept as a PDF to read in the app on request.
    await go(page, course, title)
    await tab('course.tabSources')
    await expect(row(t('today.demoNoteTitle'))).toContainText(t('course.kindNote'))
    await expect(row(t('today.demoSyllabusTitle'))).toContainText(t('course.kindPdf'))
    await open(t('today.demoSyllabusTitle'))
    await page.getByRole('button', { name: t('course.readPdfInApp') }).click()
    await expect(page.getByText(t('ai.deckPages', { count: 1 }))).toBeVisible()
    // Read in the app, each line of the syllabus keeps its own line: not one run-on paragraph.
    const words = (text: string) => text.replace(/[ \u00a0]+/g, ' ').trim()
    const syllabus = words(await main.locator('ol > li[id^="unit-"]').first().innerText())
    const taught = t('today.demoSyllabus')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map(words)
    for (const [k, line] of taught.slice(1, -1).entries()) expect(syllabus).toContain(`${line}\n${taught[k + 2] ?? ''}`)
    await go(page, course, title)
    await tab('course.tabSources')
    await open(t('today.demoNoteTitle'))
    // Rendered as it is written, it fits the screen, on a phone too: its table, formulas and code scroll sideways if
    // they must. CodeMirror draws only the lines near the screen: the note is brought to the middle first.
    await main.locator('.cm-content').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await expect(main.locator('.math-block .katex').first()).toBeVisible()
    await expect(main.getByRole('table')).toBeVisible()
    expect(await cutOff(page)).toEqual([])
    await page.getByRole('link', { name: t('course.history') }).click()
    await expect(page.getByRole('heading', { level: 1, name: t('common.historyTitle') })).toBeVisible()
    await expect(main.getByText(t('course.versionCount', { count: 1 }))).toBeVisible()

    // A subset with its own midterm: the slides, a pasted note, a study sheet.
    await go(page, course, title)
    await open(t('today.demoSecMembranes'))
    const membranes = route(page)
    await expect(page.getByTestId('place-meta')).toContainText(t('today.examCountdown', { count: 10 }))
    await tab('course.tabSources')
    await expect(row(t('today.demoDeckTitle'))).toContainText(t('ai.kindSlides'))
    await expect(row(t('course.pastedNote'))).toContainText(t('course.kindNote'))
    await tab('course.tabSheets')
    await main.getByText(t('today.demoSheet1Title')).click()
    const sheet = page.getByRole('dialog', { name: t('today.demoSheet1Title') })
    const firstPoint = /\n## (.+)\n/.exec(t('today.demoSheet1Body'))?.[1] ?? ''
    await expect(sheet.getByRole('heading', { name: firstPoint })).toBeVisible()
    await expect(sheet.getByText(t('today.demoDeckTitle')).first()).toBeVisible()
    expect(await seriousViolations(page)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)

    // A subset of the subset: a fill-in-the-blank card that says where it comes from, the lab handout by section.
    await open(t('today.demoSecTransport'))
    const transport = route(page)
    await expect(
      page.getByRole('navigation', { name: /./ }).getByRole('link', { name: t('today.demoSecMembranes') }),
    ).toBeVisible()
    await open(sentence(t('today.demoQ08')), t('common.cardTitle'))
    await expect(page.getByRole('radio', { name: t('course.kindCloze') })).toBeChecked()
    await expect(page.getByTestId('card-from')).toHaveText(
      t('course.cardFromUnit', { source: t('today.demoDeckTitle'), unit: t('ai.deckSlide', { n: 3 }) }),
    )
    await go(page, transport, t('today.demoSecTransport'))
    await tab('course.tabSources')
    await expect(row(t('today.demoDocTitle'))).toContainText(t('ai.kindDocument'))
    await open(t('today.demoDocTitle'))
    await expect(page.getByText(t('ai.deckSections', { count: 5 }))).toBeVisible()
    const sections = main.locator('ol > li[id^="unit-"]')
    await expect(sections).toHaveCount(5)
    await expect(sections.nth(3)).toContainText(t('ai.deckSection', { n: '2.1' }))
    await expect(sections.nth(3)).toContainText(t('today.demoDocSafetyTitle'))
    // Read in the app, the handout's table is a table and its steps a list: no Markdown shows.
    await expect(sections.nth(4).getByRole('table')).toBeVisible()
    await expect(sections.nth(2).getByRole('listitem')).toHaveCount(3)
    await expect(main).not.toContainText('| --- |')
    // On a phone too, the table fits or scrolls: no cell cut off.
    expect(await cutOff(page)).toEqual([])
    // A cell breaks a word only where the language hyphenates it, never mid-letter to squeeze the column.
    expect(
      await sections
        .nth(4)
        .locator('td, th')
        .evaluateAll((cells) => [...new Set(cells.map((cell) => getComputedStyle(cell).overflowWrap))]),
    ).toEqual(['normal'])
    expect(await seriousViolations(page)).toEqual([])

    // The other subset of the subset: last year's paper, read page by page.
    await go(page, membranes, t('today.demoSecMembranes'))
    await open(t('today.demoSecStructure'))
    await tab('course.tabSources')
    await expect(row(t('today.demoPdfTitle'))).toContainText(t('ai.kindDocument'))
    await open(t('today.demoPdfTitle'))
    await expect(page.getByText(t('ai.deckPages', { count: 2 }))).toBeVisible()
    await expect(main.locator('ol > li[id^="unit-"]')).toHaveCount(2)

    // « To review »: questions on the slides, on a section of the handout and on a photo.
    await go(page, '#/inbox', t('ai.inboxTitle'))
    for (const n of [2, 3, 4])
      await expect(main.getByRole('link', { name: t('ai.deckSlide', { n }), exact: true })).toBeVisible()
    await expect(main.getByRole('link', { name: t('ai.deckSection', { n: '3' }), exact: true })).toBeVisible()
    await expect(main.getByText(t('ai.inboxPhoto'), { exact: true })).toBeVisible()
    // Each question and answer shows in full, on a phone too; its quote is a passage, not a table row's Markdown.
    await settle(page)
    expect(
      await main
        .locator('textarea')
        .evaluateAll((boxes) =>
          (boxes as HTMLTextAreaElement[])
            .filter((box) => box.scrollHeight > box.clientHeight + 1)
            .map((box) => box.value.slice(0, 40)),
        ),
    ).toEqual([])
    await expect(main).not.toContainText(' | ')
    expect(await cutOff(page)).toEqual([])

    // Practice: the planned sessions (one a practice of the midterm's subset), a past one started from a plan, and
    // one tap over the course with its counts.
    await go(page, '#/sessions', t('review.practice'))
    const planned = page.getByRole('region', { name: t('review.plannedSessions') })
    const plan = (name: string) => planned.getByRole('link', { name: new RegExp(`^${literal(name)}`) })
    await expect(plan(t('today.demoPlanName'))).toBeVisible()
    await expect(plan(t('today.demoPlan2Name')).getByTestId('cramming')).toBeVisible()
    const past = page.getByRole('region', { name: t('review.pastSessions') })
    await expect(past.getByText(t('today.demoPlanName'), { exact: true })).toBeVisible()
    await go(page, course, title)
    await page.getByRole('button', { name: t('review.practiceButton') }).click()
    const practice = page.getByRole('dialog', { name: t('review.practiceScope', { scope: title }) })
    await expect(practice).toContainText(`${t('course.cardCount', { count: 16 })} · ${t('review.kindHintAll')}`)
    await page.keyboard.press('Escape')
    await expect(practice).toHaveCount(0)

    // The trash: the demo's trashed subset, its name readable and its buttons beside or below it, never over it.
    await go(page, '#/trash', t('common.trashTitle'))
    const trashed = `${title} › ${t('today.demoSecOld')}`
    const restore = page.getByRole('button', { name: t('course.restoreItem', { name: trashed }) })
    const trashRow = main.getByRole('listitem').filter({ has: restore })
    const named = await trashRow.getByText(trashed, { exact: true }).boundingBox()
    for (const button of await trashRow.getByRole('button').all()) {
      const box = await button.boundingBox()
      const apart =
        named === null ||
        box === null ||
        box.x >= named.x + named.width ||
        box.y >= named.y + named.height ||
        box.x + box.width <= named.x
      expect(apart).toBe(true)
    }
    // The name wraps between words only: as wide as its longest word at least.
    expect(named?.width ?? 0).toBeGreaterThan(120)
    expect(await cutOff(page)).toEqual([])

    // Statistics: the cramming apart, with its relaunch.
    await go(page, '#/stats', t('common.statsTitle'))
    await expect(page.getByTestId('cramming-tile')).toContainText(t('common.statsReviews', { count: 6 }))

    // Today's review: the three cards due, a fill-in-the-blank among them, asking one blank.
    await go(page, '#/', t('today.title'))
    await expect(page.getByRole('heading', { level: 2, name: t('today.heroDue', { count: 3 }) })).toBeVisible()
    await page.getByRole('button', { name: new RegExp(`^${literal(t('common.start'))}`) }).click()
    let blanks = 0
    for (let i = 0; i < 3; i++) {
      const question = page.getByTestId('question')
      await expect(question).toBeVisible()
      await expect(page.getByTestId('remaining')).toHaveText(t('review.remaining', { count: 3 - i }))
      if ((await question.textContent())?.includes('[...]')) blanks++
      await page.getByRole('button', { name: t('review.showAnswer') }).click()
      await page.getByRole('button', { name: new RegExp(`^${literal(t('review.good'))},`) }).click()
    }
    expect(blanks).toBe(1)
    expect(errors).toEqual([])
  })
}

test('pseudo-locale: the demo course is made, its content in English, the app around it pseudo', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('./?locale=pseudo#/onboarding')
  await page.getByRole('button', { name: /Ţŕý á ðéɱó çóúŕšé/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: COURSE })).toBeVisible()
  await expect(page.getByTestId('place-meta')).toContainText('16')
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(errors).toEqual([])
})
