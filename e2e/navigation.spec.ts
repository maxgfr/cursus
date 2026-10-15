import { join } from 'node:path'
import { expect, type Page, type Route, test } from '@playwright/test'
import { completionReply, configureAi } from './support/ai'
import { createHarness } from './support/harness.ts'

// Back and Close return to the screen the student came from (else to the screen's logical parent), the browser's
// back button agrees with them, and leaving a screen after an action never leaves a dead or looping entry behind.
test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

const LARGE = join(import.meta.dirname, 'fixtures', 'large.png')
const LLM = 'https://llm.mock.test/v1'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

const OFFER = 'What is an offer?'
const NOTE = 'Contract basics'

async function seedLaw(page: Page) {
  await harness.seed(page, {
    courses: [
      {
        title: 'Law',
        notes: [{ title: NOTE, body: 'An offer and its acceptance make a contract.' }],
        cards: [{ front: OFFER, back: 'A proposal to be bound' }],
      },
      { title: 'Chemistry', cards: [{ front: 'What is a mole?', back: 'An amount of substance' }] },
    ],
  })
}

/** Lands on `name` (the level-1 heading) at a URL whose hash matches `hash`. */
async function at(page: Page, name: string | RegExp, hash: RegExp) {
  await expect(page.getByRole('heading', { level: 1, name, exact: typeof name === 'string' })).toBeVisible()
  await expect(page).toHaveURL(hash)
}

/** The app's own Back link, in the screen's header. */
const back = (page: Page) => page.getByRole('main').getByRole('link', { name: 'Back', exact: true }).first()

/** Opens a screen by its hash inside the running page, as a link does (no reload). */
async function hop(page: Page, hash: string, heading: string | RegExp) {
  await page.evaluate((h) => {
    location.hash = h
  }, hash)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
}

/** Settings first (in a tab whose earlier entry is another page), then Courses, then the course Law. */
async function openLaw(page: Page) {
  await seedLaw(page)
  await page.goto('./#/settings')
  await at(page, 'Settings', /#\/settings$/)
  await hop(page, '/courses', 'Courses')
  await page.getByRole('main').getByRole('link', { name: /^Law/ }).click()
  await at(page, 'Law', /#\/course\/[^/?]+$/)
}

async function openCard(page: Page) {
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('link', { name: new RegExp(OFFER.replace('?', '\\?')) }).click()
  await at(page, 'Card', /#\/card\//)
}

/** The editor's Save. */
const save = (page: Page) => page.getByRole('button', { name: /^Save( ⌘S| Ctrl\+S)?$/ }).first()

async function openPalette(page: Page) {
  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  await expect(dialog.getByRole('combobox')).toBeFocused()
  return dialog
}

async function search(page: Page, query: string) {
  await page.getByRole('searchbox', { name: 'Search' }).fill(query)
}

test('course Back pops the course: the browser back then goes before Courses', async ({ page }) => {
  await openLaw(page)
  await back(page).click()
  await at(page, 'Courses', /#\/courses$/)
  await page.goBack()
  await at(page, 'Settings', /#\/settings$/)
})

test('card header Back and Save return to the course, and the browser back never reopens the card', async ({
  page,
}) => {
  await openLaw(page)
  await openCard(page)
  await back(page).click()
  await at(page, 'Law', /#\/course\//)
  await page.goBack()
  await at(page, 'Courses', /#\/courses$/)

  await page.goForward()
  await at(page, 'Law', /#\/course\//)
  await openCard(page)
  await page.getByRole('textbox', { name: 'Back' }).fill('A proposal to be bound by its terms')
  await save(page).click()
  await at(page, 'Law', /#\/course\//)
  await page.goBack()
  await at(page, 'Courses', /#\/courses$/)
})

test('a new card saved in a section returns to it, and the browser back goes to the course', async ({ page }) => {
  await openLaw(page)
  await page.getByRole('button', { name: 'New section' }).click()
  const dialog = page.getByRole('dialog', { name: 'New section' })
  await dialog.getByLabel('Section name').fill('Contracts')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await at(page, 'Contracts', /#\/course\/[^/]+\/s\//)
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).first().click()
  await page.getByRole('textbox', { name: 'Front' }).fill('Q1')
  await page.getByRole('textbox', { name: 'Back' }).fill('A1')
  await save(page).click()
  await at(page, 'Contracts', /#\/course\/[^/]+\/s\//)
  await page.goBack()
  await at(page, 'Law', /#\/course\/[^/]+$/)
})

test('a card opened from Search goes back to Search with its query, by Back and by Cancel', async ({ page }) => {
  await seedLaw(page)
  await page.goto('./#/')
  await at(page, 'Today', /#\/$/)
  await hop(page, '/search', 'Search')
  await search(page, 'offer')
  await page.getByRole('link', { name: new RegExp(OFFER.replace('?', '\\?')) }).click()
  await at(page, 'Card', /#\/card\//)
  await back(page).click()
  await at(page, 'Search', /#\/search\?q=offer$/)
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue('offer')

  await page.getByRole('link', { name: new RegExp(OFFER.replace('?', '\\?')) }).click()
  await at(page, 'Card', /#\/card\//)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await at(page, 'Search', /#\/search\?q=offer$/)
  await expect(page.getByRole('link', { name: new RegExp(OFFER.replace('?', '\\?')) })).toBeVisible()
  await page.goBack()
  await at(page, 'Today', /#\/$/)
})

test('a source opened from Search goes back to Search', async ({ page }) => {
  await seedLaw(page)
  await page.goto('./#/')
  await hop(page, '/search', 'Search')
  await search(page, 'contract')
  await page.getByRole('link', { name: new RegExp(NOTE) }).click()
  await at(page, NOTE, /#\/source\//)
  await back(page).click()
  await at(page, 'Search', /#\/search\?q=contract$/)
})

test('card → History → Back → Cancel returns to the course, not to History', async ({ page }) => {
  await openLaw(page)
  await openCard(page)
  await page.getByRole('link', { name: 'History', exact: true }).click()
  await at(page, 'History', /#\/history\//)
  await back(page).click()
  await at(page, 'Card', /#\/card\//)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await at(page, 'Law', /#\/course\//)
  await page.goBack()
  await at(page, 'Courses', /#\/courses$/)
})

test('trashing a card, a source, a section or a course leaves no dead entry behind', async ({ page }) => {
  await openLaw(page)
  await openCard(page)
  await page.getByRole('button', { name: 'Move to trash' }).click()
  await at(page, 'Law', /#\/course\//)
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
  await page.goBack()
  await at(page, 'Courses', /#\/courses$/)

  await page.goForward()
  await at(page, 'Law', /#\/course\//)
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByRole('link', { name: new RegExp(NOTE) }).click()
  await at(page, NOTE, /#\/source\//)
  await page.getByRole('button', { name: 'Move to trash' }).click()
  await at(page, 'Law', /#\/course\//)
  await page.goBack()
  await at(page, 'Courses', /#\/courses$/)

  await page.goForward()
  await at(page, 'Law', /#\/course\//)
  await page.getByRole('button', { name: 'New section' }).click()
  const dialog = page.getByRole('dialog', { name: 'New section' })
  await dialog.getByLabel('Section name').fill('Contracts')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await at(page, 'Contracts', /#\/course\/[^/]+\/s\//)
  await page.getByRole('button', { name: 'Section settings' }).click()
  await page
    .getByRole('dialog', { name: 'Section settings' })
    .getByRole('button', { name: 'Move section to the trash' })
    .click()
  await at(page, 'Law', /#\/course\/[^/]+$/)
  await expect(page.getByText('Section moved to the trash.')).toBeVisible()
  await page.goBack()
  await at(page, 'Courses', /#\/courses$/)

  await page.goForward()
  await at(page, 'Law', /#\/course\//)
  await page.getByRole('button', { name: 'Course settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Course settings' })
  await settings.getByRole('button', { name: 'Delete course' }).click()
  await settings.getByRole('button', { name: 'Delete course' }).click()
  await at(page, 'Courses', /#\/courses$/)
  await page.goBack()
  await at(page, 'Settings', /#\/settings$/)
})

test('a review closes back to where it started, and the browser back never restarts it', async ({ page }) => {
  await openLaw(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await at(page, 'Review', /#\/review/)
  await page.getByRole('button', { name: 'Close' }).click()
  await at(page, 'Law', /#\/course\//)
  await page.goBack()
  await at(page, 'Courses', /#\/courses$/)

  await hop(page, '/', 'Today')
  await page.getByRole('button', { name: 'Start', exact: true }).first().click()
  await at(page, 'Review', /#\/review/)
  await page.getByRole('button', { name: 'Close' }).click()
  await at(page, 'Today', /#\/$/)
  await page.goBack()
  await at(page, 'Courses', /#\/courses$/)
})

test('a session started from a deep-linked New session closes inside the app', async ({ page }) => {
  await seedLaw(page)
  await page.goto('./#/sessions/new')
  await at(page, 'New session', /#\/sessions\/new$/)
  await page.getByRole('radio', { name: 'All', exact: true }).check()
  await page.getByRole('button', { name: 'Start session' }).click()
  await expect(page).toHaveURL(/session=.*#\/review|#\/review\?session=/)
  await page.getByRole('button', { name: 'Close' }).click()
  await at(page, 'Today', /#\/$/)
})

test('Practice screens go back to Practice', async ({ page }) => {
  await seedLaw(page)
  await page.goto('./#/sessions/new')
  await back(page).click()
  await at(page, 'Practice', /#\/sessions$/)

  await page.goto('./#/stats')
  await at(page, 'Statistics', /#\/stats$/)
  await back(page).click()
  await at(page, 'Practice', /#\/sessions$/)

  await page.goto('./#/')
  await hop(page, '/sessions', 'Practice')
  await page
    .getByRole('main')
    .getByRole('link', { name: /New session/ })
    .click()
  await at(page, 'New session', /#\/sessions\/new$/)
  await back(page).click()
  await at(page, 'Practice', /#\/sessions$/)
  await page.goBack()
  await at(page, 'Today', /#\/$/)
})

test('course → New session → Back → course Back goes to Courses, not back to New session', async ({ page }) => {
  await openLaw(page)
  await page.getByRole('button', { name: 'Practice', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Custom session/ })
    .click()
  await at(page, 'New session', /#\/sessions\/new/)
  await back(page).click()
  await at(page, 'Law', /#\/course\//)
  await back(page).click()
  await at(page, 'Courses', /#\/courses$/)
})

test('New session keeps its course through a reload', async ({ page }) => {
  await openLaw(page)
  await page.getByRole('button', { name: 'Practice', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Custom session/ })
    .click()
  await at(page, 'New session', /course=.*#\/sessions\/new|#\/sessions\/new\?course=/)
  await page.reload()
  await at(page, 'New session', /course=.*#\/sessions\/new|#\/sessions\/new\?course=/)
  await back(page).click()
  await at(page, 'Law', /#\/course\//)
})

test('planning a session from Practice leaves one Practice entry', async ({ page }) => {
  await seedLaw(page)
  await page.goto('./#/')
  await hop(page, '/sessions', 'Practice')
  await page.getByRole('button', { name: 'Plan a session' }).click()
  await at(page, 'New planned session', /#\/sessions\/plan\/new$/)
  await back(page).click()
  await at(page, 'Practice', /#\/sessions$/)
  await page.goBack()
  await at(page, 'Today', /#\/$/)

  await page.goForward()
  await at(page, 'Practice', /#\/sessions$/)
  await page.getByRole('button', { name: 'Plan a session' }).click()
  await page.getByLabel('Name').fill('Morning law')
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
    await page.getByRole('checkbox', { name: day }).check()
  await page.getByRole('radio', { name: 'All', exact: true }).check()
  await page.getByLabel('Time').fill('08:00')
  await page.getByRole('button', { name: 'Save' }).click()
  await at(page, 'Practice', /#\/sessions$/)
  await expect(page.getByText('Session planned')).toBeVisible()
  await page.goBack()
  await at(page, 'Today', /#\/$/)
})

test('a settings page goes back to its opener, and the browser back does not reopen it', async ({ page }) => {
  await seedLaw(page)
  await page.goto('./#/')
  await hop(page, '/settings', 'Settings')
  await page
    .getByRole('main')
    .getByRole('link', { name: /^General/ })
    .click()
  await at(page, 'General', /#\/settings\/general$/)
  await back(page).click()
  await at(page, 'Settings', /#\/settings$/)
  await page.goBack()
  await at(page, 'Today', /#\/$/)

  await hop(page, '/inbox', 'Suggested cards')
  await page.getByRole('link', { name: 'Open AI settings' }).click()
  await at(page, 'AI', /#\/settings\/ai$/)
  await back(page).click()
  await at(page, 'Suggested cards', /#\/inbox$/)
})

test('the palette: Search returns to its opener, other screens to their logical parent', async ({ page }) => {
  await openLaw(page)
  let palette = await openPalette(page)
  await palette.getByRole('combobox').fill('Search every')
  await page.keyboard.press('Enter')
  await at(page, 'Search', /#\/search$/)
  await back(page).click()
  await at(page, 'Law', /#\/course\//)

  palette = await openPalette(page)
  await palette.getByRole('combobox').fill('Statistics')
  await page.keyboard.press('Enter')
  await at(page, 'Statistics', /#\/stats$/)
  await back(page).click()
  await at(page, 'Practice', /#\/sessions$/)
  await page.goBack()
  await at(page, 'Law', /#\/course\//)
})

test('Course → Data (Import from Anki) → Back returns to the course', async ({ page }) => {
  await openLaw(page)
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'More ways to add cards' }).click()
  await page.getByRole('link', { name: 'Import from Anki' }).click()
  await at(page, 'Data', /#\/settings\/data$/)
  await back(page).click()
  await at(page, 'Law', /#\/course\//)
})

test('a finished review: the browser back after leaving it never restarts it', async ({ page }) => {
  await openLaw(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.getByRole('button', { name: /Show answer/ }).click()
  await page.getByRole('button', { name: /^Easy, next review in/ }).click()
  await page.getByRole('button', { name: 'Back to Today' }).click()
  await at(page, 'Law', /#\/course\//)
  await page.goBack()
  await at(page, 'Courses', /#\/courses$/)
})

test('photos: Close returns to the gallery, a card made from a photo saves back to it, a trashed photo leaves no entry', async ({
  page,
}) => {
  await openLaw(page)
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByRole('link', { name: /^Photos/ }).click()
  await at(page, 'Photos', /#\/course\/[^/]+\/photos$/)
  const camera = page.getByRole('button', { name: 'Take photo' })
  const add = (await camera.isVisible()) ? camera : page.getByRole('button', { name: 'Add photos' }).first()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), add.click()])
  await chooser.setFiles(LARGE)
  await page.getByRole('link', { name: 'large' }).click()
  await at(page, 'large', /#\/photo\//)
  await page.getByRole('button', { name: 'Close' }).click()
  await at(page, 'Photos', /\/photos$/)
  await page.goBack()
  await at(page, 'Law', /#\/course\/[^/]+$/)

  await page.goForward()
  await page.getByRole('link', { name: 'large' }).click()
  await page.getByRole('button', { name: 'New card with this photo' }).click()
  await at(page, 'Card', /#\/card\//)
  await page.getByRole('textbox', { name: 'Back' }).fill('A large photo')
  await save(page).click()
  await at(page, 'large', /#\/photo\//)
  await page.getByRole('button', { name: 'Close' }).click()
  await at(page, 'Photos', /\/photos$/)
  await back(page).click()
  await at(page, 'Law', /#\/course\/[^/]+$/)
  await back(page).click()
  await at(page, 'Courses', /#\/courses$/)

  await page.goForward()
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByRole('link', { name: /^Photos/ }).click()
  await page.getByRole('link', { name: 'large' }).click()
  await page.getByRole('button', { name: 'Move to trash' }).click()
  await at(page, 'Photos', /\/photos$/)
  await page.goBack()
  await at(page, 'Law', /#\/course\/[^/]+$/)
})

test('Sync opened from Today or from Recovery goes back to its opener', async ({ page }) => {
  await seedLaw(page)
  await page.goto('./#/')
  await at(page, 'Today', /#\/$/)
  await page.getByRole('link', { name: 'Add a backup' }).click()
  await at(page, 'Sync & backup', /#\/settings\/sync$/)
  await back(page).click()
  await at(page, 'Today', /#\/$/)

  await page.goto('./#/settings/recovery')
  await page.getByRole('main').getByRole('link', { name: 'Sync & backup' }).click()
  await at(page, 'Sync & backup', /#\/settings\/sync$/)
  await back(page).click()
  await expect(page).toHaveURL(/#\/settings\/recovery$/)
})

test('AI screens opened from a course return to it, and its Back then goes to Courses', async ({ page }) => {
  await page.route(`${LLM}/**`, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    return route.fulfill(completionReply(route.request(), 'OK', CORS))
  })
  await seedLaw(page)
  await configureAi(page, LLM)
  await page.goto('./#/settings')
  await hop(page, '/courses', 'Courses')
  await page.getByRole('main').getByRole('link', { name: /^Law/ }).click()
  await at(page, 'Law', /#\/course\//)
  await page.getByRole('link', { name: /Quiz me/ }).click()
  await at(page, 'Quiz me', /quiz/)
  await page.reload()
  await at(page, 'Quiz me', /quiz/)
  await back(page).click()
  await at(page, 'Law', /#\/course\//)
  await back(page).click()
  await at(page, 'Courses', /#\/courses$/)
  await page.goBack()
  await at(page, 'Settings', /#\/settings$/)
})

test.describe('first launch', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('the demo course replaces the welcome: its Back goes to Courses', async ({ page }) => {
    await page.goto('./')
    await at(page, 'Welcome to Cursus', /#\/onboarding$/)
    await page.getByRole('button', { name: 'Try a demo course' }).click()
    await expect(page).toHaveURL(/#\/course\//)
    await back(page).click()
    await at(page, 'Courses', /#\/courses$/)
  })

  test('the welcome AI choice is used once and its query never rides along', async ({ page }) => {
    await page.goto('./#/settings')
    await at(page, 'Settings', /#\/settings$/)
    await page
      .getByRole('main')
      .getByRole('link', { name: /^Welcome to Cursus/ })
      .click()
    await at(page, 'Welcome to Cursus', /#\/onboarding$/)
    await page.getByRole('link', { name: 'With my own key' }).click()
    await at(page, 'AI', /#\/settings\/ai$/)
    expect(new URL(page.url()).search).toBe('')
    await back(page).click()
    await at(page, 'Welcome to Cursus', /#\/onboarding$/)
    await back(page).click()
    await at(page, 'Settings', /#\/settings$/)
    expect(new URL(page.url()).search).toBe('')
  })

  test('the browser back from the welcome AI choice shows the welcome again', async ({ page }) => {
    await page.goto('./#/settings')
    await hop(page, '/onboarding', 'Welcome to Cursus')
    await page.getByRole('link', { name: 'On this device (free, offline)' }).click()
    await expect(page).toHaveURL(/#\/settings\/ai/)
    await page.goBack()
    await at(page, 'Welcome to Cursus', /#\/onboarding$/)
  })
})
