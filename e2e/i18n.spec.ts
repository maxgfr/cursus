import { expect, type Page, test } from '@playwright/test'
import { createHarness } from './support/harness.ts'
import { settle, watchErrors } from './support/page.ts'
import { mainScreens, openScreen, seedLibrary } from './support/screens.ts'

test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

/** What the user typed (seeded library content) and the brand: not app strings, never translated. */
const USER_CONTENT = [
  'Zellbiologie',
  'Mitochondrien',
  'Mitochondrien erzeugen ATP.',
  'Kraftwerk der Zelle?',
  'Das Mitochondrium',
  'Ort der Photosynthese?',
  'Der Chloroplast',
  'Cursus',
]

/**
 * Visible text nodes made of letters that carry no pseudo-locale mark: app text that bypassed the catalog.
 * Skips user content, text inside an element in another language (language names in their own language),
 * and `translate="no"` content.
 */
function unmarkedText(page: Page, userContent: string[]): Promise<string[]> {
  return page.evaluate((skip) => {
    const MARK = /[[\]~áƀçðéƒĝĥíĵķļɱñóþǫŕšţúṽŵẋýžÁƁÇÐÉƑĜĤÍĴĶĻṀÑÓÞǪŔŠŢÚṼŴẊÝŽ]/
    // Dates, weekdays and durations come from Intl, which formats pseudo like English by design (intlTag):
    // text made only of Intl's English words is locale data, not a catalog string.
    const intl = new Set(['at', 'AM', 'PM'])
    const words = (s: string) => s.match(/[A-Za-z]+/g) ?? []
    for (let m = 0; m < 12; m++) {
      const month = new Date(2026, m, 1)
      const day = new Date(2026, 0, 1 + m)
      for (const style of ['long', 'short'] as const) {
        for (const w of words(month.toLocaleString('en', { month: style }))) intl.add(w)
        for (const w of words(day.toLocaleString('en', { weekday: style }))) intl.add(w)
      }
    }
    for (const unit of ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'])
      for (const unitDisplay of ['long', 'short', 'narrow'] as const)
        for (const n of [1, 2])
          for (const w of words(new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay }).format(n)))
            intl.add(w)
    const out: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').trim()
      if (!/[A-Za-z]{2}/.test(text) || MARK.test(text) || skip.some((s) => text.includes(s))) continue
      if (words(text).every((w) => intl.has(w))) continue
      const el = n.parentElement
      if (!el || el.closest('[translate="no"], script, style, .sr-only')) continue
      const lang = el.closest('[lang]')
      if (lang && lang !== document.documentElement) continue
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || el.closest('[hidden], [aria-hidden="true"]'))
        continue
      out.push(`${el.tagName.toLowerCase()}: ${text}`)
    }
    return out
  }, userContent)
}

/** Text clipped by its box: content wider or taller than an element that hides its overflow. */
function clippedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
      const hasText = [...el.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && /\S/.test(c.textContent ?? ''))
      if (!hasText || el.closest('.sr-only, [aria-hidden="true"], [hidden]')) continue
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const hidesX = s.overflowX !== 'visible' && s.overflowX !== 'auto' && s.overflowX !== 'scroll'
      const hidesY = s.overflowY !== 'visible' && s.overflowY !== 'auto' && s.overflowY !== 'scroll'
      if ((hidesX && el.scrollWidth > el.clientWidth + 1) || (hidesY && el.scrollHeight > el.clientHeight + 1))
        out.push(`${el.tagName.toLowerCase()}: ${(el.textContent ?? '').trim().slice(0, 60)}`)
    }
    return out
  })
}

/** The large title and the header's trailing controls (sync chip, "+") must never cover each other. */
function headerOverlap(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const title = document.querySelector('main h1')
    const header = title?.closest('header')
    if (!title || !header) return []
    // The text's own box: a title squeezed narrower than its words spills out of its element.
    const range = document.createRange()
    range.selectNodeContents(title)
    const a = range.getBoundingClientRect()
    const out: string[] = []
    for (const el of header.querySelectorAll<HTMLElement>('a, button, [role="status"]')) {
      const b = el.getBoundingClientRect()
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (x > 0 && y > 0) out.push(`"${title.textContent}" under "${el.textContent || el.getAttribute('aria-label')}"`)
    }
    return out
  })
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test('pseudo: every visible app string on every main screen carries the pseudo marker', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = watchErrors(page)
  await seedLibrary(harness, page)
  const query = '?locale=pseudo'
  const problems: string[] = []
  for (const hash of await mainScreens(page, query)) {
    await openScreen(page, query, hash)
    await settle(page)
    for (const p of await unmarkedText(page, USER_CONTENT)) problems.push(`${hash} ${p}`)
  }
  expect(problems).toEqual([])
  expect(errors).toEqual([])
})

test('German: no horizontal overflow and no clipped text on any main screen', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = watchErrors(page)
  await seedLibrary(harness, page)
  const query = '?locale=de'
  const problems: string[] = []
  for (const hash of await mainScreens(page, query)) {
    await openScreen(page, query, hash)
    await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE')
    await settle(page)
    const overflow = await horizontalOverflow(page)
    if (overflow > 0) problems.push(`${hash} overflows by ${overflow}px`)
    for (const p of await clippedText(page)) problems.push(`${hash} clipped ${p}`)
    for (const p of await headerOverlap(page)) problems.push(`${hash} header ${p}`)
  }
  expect(problems).toEqual([])
  expect(errors).toEqual([])
})

test('French: the app speaks French and fits the screen', async ({ page }) => {
  const errors = watchErrors(page)
  await seedLibrary(harness, page, 'Biologie cellulaire')
  const query = '?locale=fr'
  await openScreen(page, query, '#/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr-FR')
  await expect(page.getByRole('heading', { level: 1, name: 'Aujourd’hui' })).toBeVisible()
  // The course's share of today, in French.
  await expect(page.getByRole('main').getByRole('button', { name: /^Biologie cellulaire/ })).toContainText(
    '2 cartes · Réviser ce cours',
  )
  const problems: string[] = []
  for (const hash of ['#/', '#/courses', '#/review', '#/settings', '#/settings/sync', '#/stats']) {
    await openScreen(page, query, hash)
    await settle(page)
    const overflow = await horizontalOverflow(page)
    if (overflow > 0) problems.push(`${hash} overflows by ${overflow}px`)
    for (const p of await headerOverlap(page)) problems.push(`${hash} header ${p}`)
  }
  expect(problems).toEqual([])
  expect(errors).toEqual([])
})

for (const locale of ['fr', 'de'] as const) {
  test(`first launch in ${locale}: the header never overlaps, the empty state's actions share its left edge`, async ({
    page,
  }, info) => {
    const errors = watchErrors(page)
    await harness.seed(page)
    for (const hash of ['#/', '#/courses']) {
      await openScreen(page, `?locale=${locale}`, hash)
      await settle(page)
      expect(await headerOverlap(page)).toEqual([])
      const empty = page
        .getByRole('main')
        .locator('section')
        .filter({ has: page.getByRole('heading', { level: 2 }) })
      const heading = await empty.getByRole('heading', { level: 2 }).boundingBox()
      const action = await empty.getByRole('button').first().boundingBox()
      if (!heading || !action) throw new Error('empty state not laid out')
      expect(Math.abs(action.x - heading.x)).toBeLessThanOrEqual(1)
      const link = hash === '#/' ? await empty.getByRole('link').boundingBox() : null
      if (link) expect(Math.abs(link.x - heading.x)).toBeLessThanOrEqual(1)
    }
    // Desktop Courses: the header "+" sits on the large title's centre line.
    if (info.project.name !== 'webkit-iphone') {
      const title = await page.getByRole('heading', { level: 1 }).boundingBox()
      const plus = await page.locator('main h1 + div').getByRole('button').boundingBox()
      if (!title || !plus) throw new Error('header not laid out')
      expect(Math.abs(title.y + title.height / 2 - (plus.y + plus.height / 2))).toBeLessThanOrEqual(1)
    }
    expect(errors).toEqual([])
  })
}

test('Settings: the interface language is picked on the device, applied in place and kept', async ({ page }) => {
  const errors = watchErrors(page)
  await harness.seed(page)
  await openScreen(page, '', '#/settings')
  const language = page.getByRole('group', { name: 'Language' })
  await expect(language.getByRole('radio', { name: 'Automatic' })).toBeChecked()
  await language.getByRole('radio', { name: 'Deutsch' }).check()
  // In place: same page, no reload, the heading and <html lang> follow.
  await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE')
  await expect(page.getByRole('group', { name: 'Sprache' }).getByRole('radio', { name: 'Deutsch' })).toBeChecked()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible()
  await page.getByRole('group', { name: 'Sprache' }).getByRole('radio', { name: 'Automatisch' }).check()
  // Automatic follows the browser language (English here).
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  expect(errors).toEqual([])
})
