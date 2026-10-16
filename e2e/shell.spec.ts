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
  // The sheet opens on its field, not its Close button, so the phone keyboard comes up.
  await expect(input).toBeFocused()
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
    // No hidden brand heading read before every page's <h1>.
    await expect(nav.getByRole('heading')).toHaveCount(0)
    await expect(nav.getByText('Cursus')).toBeHidden()
    // Tab labels sit on the type ramp (Caption, 13px), not an off-scale 11px.
    const label = await links
      .first()
      .locator('span')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
    expect(label).toBeGreaterThanOrEqual(13)
  } else {
    // Sidebar: left column, full height, content capped near 720px.
    expect(box.x).toBeLessThanOrEqual(1)
    expect(box.height).toBeGreaterThanOrEqual(vp.height - 1)
    expect(box.width).toBeLessThan(vp.width / 2)
    // The brand is a label, not a heading before the page's <h1>.
    await expect(nav.getByText('Cursus', { exact: true })).toBeVisible()
    await expect(nav.getByRole('heading', { name: 'Cursus' })).toHaveCount(0)
    // Search is one click from the shell, with its ⌘K / Ctrl K shortcut hinted.
    const search = nav.getByRole('link', { name: 'Search' })
    await expect(search).toBeVisible()
    await expect(search).toHaveAttribute('aria-keyshortcuts', /^(Meta|Control)\+K$/)
    await expect(search.locator('kbd')).toHaveText(/^(⌘K|Ctrl K)$/)
    // One voice: inactive icons are ink, only the current row's icon is accent.
    const iconColor = (name: string) =>
      nav
        .getByRole('link', { name, exact: true })
        .locator('svg')
        .evaluate((el) => getComputedStyle(el).color)
    expect(await iconColor('Courses')).not.toBe(await iconColor('Today'))
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

  await nav.getByRole('link', { name: 'Practice' }).click()
  await expect(page).toHaveURL(/#\/sessions$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Practice' })).toBeVisible()
  await page.goto('./#/quiz')
  await expect(page).toHaveURL(/#\/quiz$/)
  await expect(nav.getByRole('link', { name: 'Practice' })).toHaveAttribute('aria-current', 'page')

  await nav.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  // The appearance and the language are on the settings themselves, no page of their own.
  await expect(page.getByRole('main').getByRole('group', { name: 'Appearance', exact: true })).toBeVisible()
  await expect(page.getByRole('main').getByRole('group', { name: 'Language' })).toBeVisible()
  await page.getByRole('link', { name: 'Schedule' }).click()
  await expect(page).toHaveURL(/#\/settings\/review$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Schedule' })).toBeVisible()
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page).toHaveURL(/#\/settings$/)
  // An older link to General lands on the settings.
  await page.goto('./#/settings/general')
  await expect(page).toHaveURL(/#\/settings$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()

  // Every route renders its own heading when opened directly.
  const routes: [string, string][] = [
    ['#/trash', 'Trash'],
    ['#/stats', 'Statistics'],
    ['#/quiz', 'Quiz me'],
    ['#/settings/sync', 'Sync & backup'],
    ['#/settings/ai', 'AI'],
    ['#/settings/seal', 'Security'],
    ['#/settings/pair', 'Pair a device'],
    ['#/settings/data', 'Import & export'],
    ['#/settings/security', 'Security'],
    ['#/settings/recovery', 'Security'],
    ['#/settings/review', 'Schedule'],
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
  await expect(page.getByRole('heading', { name: 'Add your first card' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: /Makroökonomie II/ })).toBeVisible()
  if (!isPhone(info.project.name)) {
    const nav = page.getByRole('navigation', { name: 'Main' })
    const row = nav.getByRole('link', { name: /Makroökonomie II/ })
    await expect(row).toBeVisible()
  }
  // Survives a reload: the edit went through the local log.
  await page.waitForTimeout(300)
  await page.reload()
  await expect(page.getByRole('main').getByRole('link', { name: /Makroökonomie II/ })).toBeVisible()
  if (!isPhone(info.project.name)) {
    // On a course page only the most specific row is the page.
    const nav = page.getByRole('navigation', { name: 'Main' })
    const row = nav.getByRole('link', { name: /Makroökonomie II/ })
    await row.click()
    await expect(row).toHaveAttribute('aria-current', 'page')
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
    await expect(nav.getByRole('link', { name: 'Courses', exact: true })).not.toHaveAttribute('aria-current', 'page')
  }
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

test('one blue accent: the blue course colour reads as indigo, never as the accent', async ({ page }) => {
  // Hue in degrees of a #rrggbb token, read from the live stylesheet.
  const hues = () =>
    page.evaluate(() => {
      const hue = (name: string) => {
        const hex = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
        const channel = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255
        const r = channel(1)
        const g = channel(3)
        const b = channel(5)
        const max = Math.max(r, g, b)
        const d = max - Math.min(r, g, b)
        const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
        return (h * 60 + 360) % 360
      }
      return { accent: hue('--accent'), blue: hue('--course-blue'), purple: hue('--course-purple') }
    })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await openToday(page)
    const { accent, blue, purple } = await hues()
    // Clearly off the accent toward indigo, and still apart from purple.
    expect(blue - accent).toBeGreaterThan(12)
    expect(purple - blue).toBeGreaterThan(8)
  }
})

test('a long German title keeps its trailing control on the first line', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page, '?locale=de')
  await page.getByRole('button', { name: 'Neuer Kurs' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Neuer Kurs' })
  const input = dialog.getByRole('textbox').first()
  await expect(input).toBeFocused()
  const title = 'Einführung in das deutsche und europäische Kartellrecht mit Fallübungen'
  await input.fill(title)
  await input.press('Enter')
  const h1 = page.getByRole('heading', { level: 1, name: title })
  await expect(h1).toBeVisible()
  const trailing = page.locator('main h1 + div')
  const t = await h1.boundingBox()
  const c = await trailing.boundingBox()
  if (!t || !c) throw new Error('header not laid out')
  // Beside the title's first line, never on an orphan row, never overlapping it.
  expect(c.y).toBeLessThan(t.y + 40)
  expect(c.x).toBeGreaterThanOrEqual(t.x + t.width - 1)
  expect(errors).toEqual([])
})

test('dark segmented control: the selected segment is lifted above the track', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('./#/settings')
  const label = page.locator('input[type="radio"]:checked + *').first()
  await expect(label).toBeVisible()
  const lum = (c: string) => {
    const [r = 0, g = 0, b = 0] = (c.match(/\d+(\.\d+)?/g) ?? []).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const seg = await label.evaluate((el) => getComputedStyle(el).backgroundColor)
  const track = await label.evaluate((el) => getComputedStyle(el.parentElement?.parentElement ?? el).backgroundColor)
  expect(lum(seg)).toBeGreaterThan(lum(track))
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
    for (const hash of ['#/settings', '#/understand', '#/settings/security', '#/review']) {
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
  await expect(page.getByRole('heading', { name: 'Add your first card' })).toBeVisible()
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

test('Automatic language follows a system language change live, with regional formats', async ({ page }) => {
  const errors = watchErrors(page)
  await page.addInitScript(() => {
    const w = window as unknown as { __langs: string[] }
    w.__langs = ['en-GB']
    Object.defineProperty(navigator, 'languages', { configurable: true, get: () => w.__langs })
    Object.defineProperty(navigator, 'language', { configurable: true, get: () => w.__langs[0] })
  })
  await openToday(page)
  // en-GB keeps British formats: <html lang> is regional, the date reads day before month.
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB')
  await page.evaluate(() => {
    ;(window as unknown as { __langs: string[] }).__langs = ['fr-CA', 'en-GB']
    window.dispatchEvent(new Event('languagechange'))
  })
  await expect(page.getByRole('heading', { level: 1, name: 'Aujourd’hui' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr-CA')
  expect(errors).toEqual([])
})

/** Hash navigation inside the running page (no reload: what the page recorded stays in memory). */
async function goHash(page: Page, hash: string) {
  await page.evaluate((h) => {
    location.hash = h
  }, hash)
}

test('a screen whose code fails to load says so calmly, with a retry, and the failure is recorded', async ({
  page,
  browserName,
}) => {
  const thrown: string[] = []
  page.on('pageerror', (e) => thrown.push(e.message))
  await openToday(page)
  const stats = /\/assets\/Stats-[^/]+\.(js|css)$/
  await page.route(stats, (route) => route.abort())
  await goHash(page, '#/stats')
  const calm = page.getByRole('heading', { name: 'This part didn’t load.' })
  await expect(calm).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  // The shell around it still works: the failure is in the diagnostic report.
  await page.unroute(stats)
  await goHash(page, '#/settings/diagnostic')
  await expect(page.locator('pre')).toContainText(' chunk.stats ')
  // Back on the screen, the retry loads it. WebKit keeps a failed module import failed for the life of the
  // page: there the retry fails again, and the action becomes a reload.
  await goHash(page, '#/stats')
  await page.getByRole('button', { name: 'Try again' }).click()
  if (browserName === 'webkit') await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
  else await expect(page.getByRole('heading', { level: 1, name: 'Statistics' })).toBeVisible()
  expect(thrown).toEqual([])
})

test('reloading while deferred chunks are still loading raises no page error', async ({ page }) => {
  const thrown: string[] = []
  page.on('pageerror', (e) => thrown.push(e.message))
  // The chunks fetched right after Today paints never arrive before the reload.
  const deferred = /\/assets\/(Notices|CommandPalette|ExamLead|virtual_pwa-register)-[^/]+\.js$/
  const held = page.waitForRequest(deferred)
  await page.route(deferred, () => {})
  await openToday(page)
  await held
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: /Today/ })).toBeVisible()
  // Whatever the aborted loads reported has had its turn.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)))
  expect(thrown).toEqual([])
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('blocked service workers skip the update machinery without recording a failure', async ({ page }) => {
  const thrown: string[] = []
  page.on('pageerror', (e) => thrown.push(e.message))
  // This file blocks service workers: `register()` resolves without a registration. The app has asked once it warns.
  const asked = page.waitForEvent('console', (m) => m.text().includes('Service Worker registration blocked'))
  await openToday(page)
  await asked
  await goHash(page, '#/settings/diagnostic')
  await expect(page.locator('pre')).toContainText('"errors"')
  expect(await page.locator('pre').textContent()).not.toContain('pwa.start')
  expect(thrown).toEqual([])
})
