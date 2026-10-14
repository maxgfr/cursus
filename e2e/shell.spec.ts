import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

const isPhone = (name: string) => name === 'webkit-iphone'

/** Collects console errors and uncaught exceptions for the whole test. */
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

async function openToday(page: Page, query = '') {
  await page.goto(`./${query}#/`)
  await expect(page.getByRole('heading', { level: 1, name: /Today|Heute|Aujourd/ })).toBeVisible()
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

async function createCourse(page: Page, title: string) {
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await expect(dialog).toBeVisible()
  const input = dialog.getByLabel('Course name')
  await expect(input).toHaveAttribute('enterkeyhint', 'done')
  await input.fill(title)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

test('viewport meta, safe areas and full-height layout', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content')
  expect(viewport).toContain('viewport-fit=cover')
  expect(viewport).toContain('width=device-width')
  const { bodyHeight, innerHeight } = await page.evaluate(() => ({
    bodyHeight: document.body.getBoundingClientRect().height,
    innerHeight: window.innerHeight,
  }))
  expect(bodyHeight).toBeGreaterThanOrEqual(innerHeight - 1)
  // Inputs never trigger iOS zoom.
  await createCourse(page, 'Biology')
  await page.goto('./#/search')
  const fontSize = await page.getByRole('searchbox').evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
  expect(fontSize).toBeGreaterThanOrEqual(16)
  await expect(page.getByRole('searchbox')).toHaveAttribute('enterkeyhint', 'search')
  expect(errors).toEqual([])
})

test('tab bar on phone, sidebar on iPad landscape and Mac', async ({ page }, info) => {
  const errors = watchErrors(page)
  await openToday(page)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav).toBeVisible()
  const box = await nav.boundingBox()
  const vp = page.viewportSize()
  if (!box || !vp) throw new Error('no layout')
  const links = nav.getByRole('link')
  if (isPhone(info.project.name)) {
    // Bottom tab bar: full width, pinned to the bottom, four items.
    expect(box.width).toBeGreaterThanOrEqual(vp.width - 1)
    expect(box.y + box.height).toBeGreaterThanOrEqual(vp.height - 1)
    await expect(links).toHaveCount(4)
    await expect(nav.getByRole('heading', { name: 'Cursus' })).toBeAttached()
  } else {
    // Sidebar: left column, full height, content capped near 720px.
    expect(box.x).toBeLessThanOrEqual(1)
    expect(box.height).toBeGreaterThanOrEqual(vp.height - 1)
    expect(box.width).toBeLessThan(vp.width / 2)
    await expect(nav.getByRole('heading', { name: 'Cursus' })).toBeVisible()
    const main = await page.locator('#main > *').first().boundingBox()
    expect(main?.width ?? 0).toBeLessThanOrEqual(720)
  }
  await expect(links.filter({ hasText: 'Today' })).toHaveAttribute('aria-current', 'page')
  expect(errors).toEqual([])
})

test('hash navigation between routes', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  const nav = page.getByRole('navigation', { name: 'Main' })

  await nav.getByRole('link', { name: 'Courses' }).click()
  await expect(page).toHaveURL(/#\/courses$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Courses' })).toBeVisible()

  await nav.getByRole('link', { name: 'Understand' }).click()
  await expect(page).toHaveURL(/#\/understand$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Understand' })).toBeVisible()
  await page.getByRole('link', { name: 'Generate cards' }).click()
  await expect(page).toHaveURL(/#\/generate$/)

  await nav.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await page.getByRole('link', { name: 'General' }).click()
  await expect(page).toHaveURL(/#\/settings\/general$/)
  await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible()
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page).toHaveURL(/#\/settings$/)

  // Every route renders its own heading when opened directly.
  const routes: [string, string][] = [
    ['#/trash', 'Trash'],
    ['#/stats', 'Statistics'],
    ['#/quiz', 'Quiz me'],
    ['#/settings/sync', 'Sync & backup'],
    ['#/settings/ai', 'AI'],
    ['#/settings/seal', 'Encryption'],
    ['#/settings/pair', 'Pair a device'],
    ['#/settings/data', 'Data'],
    ['#/settings/recovery', 'Recovery'],
    ['#/settings/review', 'Review'],
    ['#/settings/diagnostic', 'Diagnostics'],
    ['#/onboarding', 'Welcome to Cursus'],
    ['#/course/nope', 'This page doesn’t exist'],
    ['#/no/such/route', 'This page doesn’t exist'],
  ]
  for (const [hash, heading] of routes) {
    await page.goto(`./${hash}`)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  }

  // Review is a focus view: no navigation chrome.
  await page.goto('./#/review')
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page).toHaveURL(/#\/$/)
  expect(errors).toEqual([])
})

test('a created course appears on Today and in the course list', async ({ page }, info) => {
  const errors = watchErrors(page)
  await openToday(page)
  await expect(page.getByRole('heading', { name: 'Start with a course' })).toBeVisible()
  await createCourse(page, 'Makroökonomie II')
  await page.getByRole('link', { name: 'Back' }).click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Today' }).click()
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: /Makroökonomie II/ })).toBeVisible()
  if (!isPhone(info.project.name)) {
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Makroökonomie II/ }),
    ).toBeVisible()
  }
  // Survives a reload: the edit went through the local log.
  await page.waitForTimeout(300)
  await page.reload()
  await expect(page.getByRole('main').getByRole('link', { name: /Makroökonomie II/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('light and dark themes are both designed', async ({ page }) => {
  const errors = watchErrors(page)
  await page.emulateMedia({ colorScheme: 'light' })
  await openToday(page)
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const ink = () => page.evaluate(() => getComputedStyle(document.body).color)
  expect(await bg()).toBe('rgb(242, 244, 247)')
  expect(await ink()).toBe('rgb(16, 24, 40)')
  await page.emulateMedia({ colorScheme: 'dark' })
  // Let colour transitions settle before measuring contrast.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
  expect(await bg()).toBe('rgb(11, 13, 18)')
  expect(await ink()).toBe('rgb(242, 244, 247)')
  const results = await new AxeBuilder({ page }).analyze()
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => v.id)).toEqual([])
  expect(errors).toEqual([])
})

test('reduced motion turns the Start morph into a crossfade', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openToday(page)
  await createCourse(page, 'Statistics')
  await page.goto('./#/')
  const hero = page.locator('section[aria-labelledby="today-hero"]')
  const name = () => hero.evaluate((el) => getComputedStyle(el).getPropertyValue('view-transition-name'))
  await expect(hero).toBeVisible()
  expect(await name()).toBe('review-focus')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await name()).toBe('none')
  const duration = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dur-fast'))
  expect(duration.trim()).toMatch(/^0m?s$/)
})

test('no horizontal overflow, even with long German and pseudo strings', async ({ page }) => {
  const errors = watchErrors(page)
  for (const query of ['', '?locale=de', '?locale=pseudo']) {
    await page.goto(`./${query}#/`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await noHorizontalOverflow(page)
    for (const hash of ['#/settings', '#/understand', '#/settings/general', '#/review']) {
      await page.goto(`./${query}${hash}`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await noHorizontalOverflow(page)
    }
  }
  expect(errors).toEqual([])
})

test('keyboard focus is visible and reaches the navigation', async ({ page, browserName }) => {
  await openToday(page)
  // Safari only tabs to every control with Option held.
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
  await page.keyboard.press(tab)
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  const skipBox = await skip.boundingBox()
  expect(skipBox?.y ?? -1).toBeGreaterThanOrEqual(0)
  await page.keyboard.press(tab)
  const focused = page.locator(':focus')
  await expect(focused).toHaveText(/Today/)
  const outline = await focused.evaluate((el) => {
    const s = getComputedStyle(el)
    return { style: s.outlineStyle, width: Number.parseFloat(s.outlineWidth) }
  })
  expect(outline.style).not.toBe('none')
  expect(outline.width).toBeGreaterThanOrEqual(2)
})

test('Today passes axe with no serious or critical violations', async ({ page }) => {
  await openToday(page)
  const empty = await new AxeBuilder({ page }).analyze()
  expect(empty.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
  await createCourse(page, 'Droit des contrats')
  await page.goto('./#/')
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible()
  const filled = await new AxeBuilder({ page }).analyze()
  expect(filled.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual(
    [],
  )
})

test('another tab upgrading the database shows a blocking banner on any route', async ({ page }) => {
  await openToday(page)
  await page.goto('./#/search')
  await expect(page.getByRole('searchbox')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const probe = indexedDB.open('cursus-v1')
        probe.onerror = () => reject(probe.error)
        probe.onsuccess = () => {
          const version = probe.result.version
          probe.result.close()
          const up = indexedDB.open('cursus-v1', version + 1)
          up.onerror = () => reject(up.error)
          up.onsuccess = () => {
            up.result.close()
            resolve()
          }
        }
      }),
  )
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Cursus was updated in another tab')
  await expect(alert.getByRole('button', { name: 'Reload' })).toBeVisible()
})
