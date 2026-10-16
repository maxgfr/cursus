import { join } from 'node:path'
import { expect, type Page, type Route, test } from '@playwright/test'
import { configureAi } from './support/ai.ts'
import { createHarness, type SeedCard } from './support/harness.ts'
import { watchErrors } from './support/page.ts'

// Without an AI model, Cursus is a study app with no trace of AI (the AI settings and the welcome's AI step
// aside): no chat, no AI button, no AI wording, ⌘J left alone, and nothing queued for later when a document or a
// photo is added. Once a model is set up, the same screens offer it again.
test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

const LLM = 'https://llm.mock.test/v1'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}
const DECKS = join(import.meta.dirname, '..', 'tests', 'fixtures', 'content')
const PHOTO = join(import.meta.dirname, 'fixtures', 'large.png')
const DAY = 86_400_000
const LEECH_FRONT = 'Australia capital (not Sydney!!) city name?'

/** A card that lapsed eight times, long enough ago to be due today: a hard card, the one « Improve » is for. */
function leechHistory(now: number): SeedCard['reviews'] {
  const start = now - 400 * DAY
  const reviews: NonNullable<SeedCard['reviews']> = [{ rating: 4, at: start }]
  for (let i = 1; i <= 8; i++) {
    reviews.push({ rating: 1, at: start + i * 10 * DAY })
    reviews.push({ rating: 3, at: start + i * 10 * DAY + 600_000 })
  }
  return reviews
}

/** Every AI entry point outside the AI settings, by the start of its accessible name. */
const AI_LABELS = [
  'Ask about this',
  'Ask about “',
  'Generate cards',
  'Quiz me',
  'Write with AI',
  'Suggest cards',
  'Create cards',
  'Explain with AI',
  'Explain this photo',
  'Explain the question',
  'Answer in your own words',
  'A hint',
  'Why?',
  'A mnemonic',
  'Summarise this source',
  'Improve',
  'Set up AI',
  'Open AI settings',
]
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const AI_NAME = new RegExp(`^(?:${AI_LABELS.map(literal).join('|')})`)

/** The chat: docked beside the page, or a sheet on phones. */
const chat = (page: Page) =>
  page.getByRole('complementary', { name: 'Ask' }).or(page.getByRole('dialog', { name: 'Ask' }))

/** Nothing of the AI on the screen: no AI button or link, no chat, no sentence naming the AI. */
async function noAi(page: Page) {
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: AI_NAME })).toHaveCount(0)
  await expect(page.getByRole('link', { name: AI_NAME })).toHaveCount(0)
  await expect(chat(page)).toHaveCount(0)
  await expect(page.getByRole('main').getByText(/\bAI\b/)).toHaveCount(0)
}

async function openCourse(page: Page): Promise<string> {
  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
  const courseId = decodeURIComponent(/#\/course\/([^/?]+)/.exec(page.url())?.[1] ?? '')
  expect(courseId).not.toBe('')
  return courseId
}

async function selectText(page: Page, container: string, word: string) {
  await page
    .locator(container)
    .first()
    .evaluate((root, w) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const at = n.textContent?.indexOf(w) ?? -1
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(n, at)
        range.setEnd(n, at + w.length)
        const selection = document.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return
      }
      throw new Error(`"${w}" is not on the page`)
    }, word)
}

/** The suggestion queue as stored on this device (`ai:jobs` in the device kv): what was ever queued. */
async function storedJobs(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('cursus-v1')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const get = db.transaction('kv').objectStore('kv').get('ai:jobs')
          get.onerror = () => reject(get.error)
          get.onsuccess = () => {
            const jobs = (get.result as { jobs?: unknown[] } | undefined)?.jobs
            db.close()
            resolve(Array.isArray(jobs) ? jobs.length : 0)
          }
        }
      }),
  )
}

test('without a model: a whole journey with no trace of AI, ⌘J does nothing, nothing is queued', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = watchErrors(page)
  const calls: string[] = []
  await page.route(`${LLM}/**`, (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    calls.push(req.url())
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      json: {
        id: 'cmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'claude-haiku-5-5',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    })
  })
  await harness.seed(page, {
    courses: [
      {
        title: 'Biology',
        notes: [{ title: 'Cell notes', body: 'The mitochondrion produces ATP through cellular respiration.' }],
        cards: [{ front: LEECH_FRONT, back: 'Canberra', reviews: leechHistory(Date.now()) }],
      },
    ],
  })

  // Today: the cards due, nothing else; ⌘J is left to the browser and the palette offers nothing of the AI.
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await noAi(page)
  await page.keyboard.press('ControlOrMeta+j')
  await expect(chat(page)).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('Ask')
  await expect(palette.getByRole('option', { name: 'Ask about this' })).toHaveCount(0)
  await palette.getByRole('combobox').fill('Suggested')
  await expect(palette.getByRole('option', { name: 'Suggested cards' })).toHaveCount(0)
  // The palette still works: it is only the AI that is missing.
  await palette.getByRole('combobox').fill('Biology')
  await expect(palette.getByRole('option', { name: /Biology/ }).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()

  // The course: cards, sources and study sheets, written by hand.
  const courseId = await openCourse(page)
  await noAi(page)
  await page.getByRole('radio', { name: 'Study sheets' }).check({ force: true })
  await expect(page.getByText('A study sheet sums up a topic on one page.', { exact: true })).toBeVisible()
  await noAi(page)
  await page.getByRole('radio', { name: 'Cards' }).check({ force: true })
  await page.getByRole('main').getByRole('button', { name: 'New card' }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Card' })).toBeVisible()
  await noAi(page)
  await page.getByRole('textbox', { name: 'Front' }).click()
  await page.keyboard.type('What does the mitochondrion make?')
  await page.getByRole('textbox', { name: 'Back' }).click()
  await page.keyboard.type('ATP')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Card added.')).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: /What does the mitochondrion make\?/ })).toBeVisible()
  await noAi(page)
  // The toast can sit over the rows on a phone.
  await page.getByRole('button', { name: 'Dismiss' }).click()

  // A note: read and selected, nothing to ask.
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page
    .getByRole('main')
    .getByRole('link', { name: /Cell notes/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Cell notes' })).toBeVisible()
  await noAi(page)
  await selectText(page, '.cm-content', 'ATP')
  await noAi(page)

  // Slides: saved and read slide by slide, nothing to create with AI, nothing queued.
  await openCourse(page)
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page.getByLabel('Add files').setInputFiles(join(DECKS, 'slides.pdf'))
  await expect(page.getByRole('heading', { level: 1, name: 'Cell Biology slides' })).toBeVisible()
  await expect(page.getByRole('main').getByText(/^\d+ slides$/)).toBeVisible()
  await noAi(page)
  // The slides importer lists the decks already in: each opens as a source, none offers to create cards.
  await page.goto('./#/import')
  const deck = page.getByRole('main').getByRole('link', { name: /Cell Biology slides/ })
  await expect(deck).toBeVisible()
  await noAi(page)
  await deck.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Cell Biology slides' })).toBeVisible()
  await noAi(page)
  // An old link to its card creation (a bookmark, the history) opens the slides themselves, nothing of the AI.
  const deckId = /#\/source\/([^/?]+)/.exec(page.url())?.[1] ?? ''
  expect(deckId).not.toBe('')
  await page.goto(`./#/source/${deckId}/questions`)
  await expect(page.getByRole('heading', { level: 1, name: 'Cell Biology slides' })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`#/source/${deckId}$`))
  await noAi(page)

  // A photo: a card can be made from it, nothing explains it.
  await page.goto(`./#/course/${encodeURIComponent(courseId)}/photos`)
  await expect(page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible()
  await page.locator('input[type="file"][multiple]').setInputFiles([PHOTO])
  await expect(page.getByTestId('photo-tile').locator('img')).toHaveCount(1)
  await noAi(page)
  await page.getByTestId('photo-tile').first().getByRole('link').click()
  await expect(page).toHaveURL(/#\/photo\//)
  await expect(page.getByRole('button', { name: 'New card with this photo' })).toBeVisible()
  await noAi(page)

  // Review: the hard card says so and can be suspended, nothing offers to explain, hint or improve.
  await page.goto('./#/review')
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible()
  // The card written above and the hard card are both due, in either order: go through them up to the hard one.
  const question = page.getByTestId('question')
  let leech = false
  for (let i = 0; i < 2 && !leech; i++) {
    await expect(question).toBeVisible()
    const front = (await question.textContent()) ?? ''
    leech = front.includes(LEECH_FRONT)
    if (leech) await expect(page.getByText('Hard card', { exact: true })).toBeVisible()
    await noAi(page)
    await page.getByRole('button', { name: /Show answer/ }).click()
    await expect(page.getByTestId('answer')).toBeVisible()
    await noAi(page)
    await page.getByRole('button', { name: /^Good,/ }).click()
    if (!leech) await expect(question).not.toHaveText(front)
  }
  expect(leech).toBe(true)

  // Practice and the suggested cards: nothing of the AI, nothing waiting.
  await page.goto('./#/sessions')
  await expect(page.getByRole('heading', { level: 1, name: 'Practice' })).toBeVisible()
  await noAi(page)
  await page.goto('./#/inbox')
  await expect(page.getByRole('heading', { level: 1, name: 'Suggested cards' })).toBeVisible()
  await expect(page.getByText('No card is waiting for your approval.')).toBeVisible()
  await noAi(page)

  // Neither the slides nor the photo were queued for later.
  expect(await storedJobs(page)).toBe(0)
  expect(calls).toEqual([])
  expect(errors).toEqual([])

  // Once a model is set up, the same screens offer it; what was added before stays as it was.
  await configureAi(page, LLM)
  await openCourse(page)
  await expect(page.getByRole('main').getByRole('button', { name: 'Ask about this' }).first()).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'Generate cards' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'Quiz me' })).toBeVisible()
  await page.goto('./#/inbox')
  await expect(page.getByRole('heading', { name: 'No suggested cards' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Cell Biology slides', exact: true })).toHaveCount(0)
  expect(await storedJobs(page)).toBe(0)
})

test('« Show AI features » off: a model set up, yet no trace of AI, suggested cards included; on again, it is all back', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await harness.seed(page, {
    courses: [
      {
        title: 'Biology',
        notes: [
          {
            title: 'Cell notes',
            body: 'The mitochondrion produces ATP.',
            drafts: [{ front: 'What does the mitochondrion produce?', back: 'ATP' }],
          },
        ],
      },
    ],
  })
  await configureAi(page, LLM)
  await openCourse(page)
  await expect(page.getByRole('main').getByRole('button', { name: 'Ask about this' }).first()).toBeVisible()
  await expect(page.getByTestId('course-drafts')).toContainText('1 suggested card')
  const suggested = async (shown: boolean) => {
    const count = shown ? 1 : 0
    await page.goto('./#/')
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    await expect(page.getByTestId('drafts-hero').or(page.getByTestId('drafts-line'))).toHaveCount(count)
    await openCourse(page)
    await expect(page.getByTestId('course-drafts')).toHaveCount(count)
    await page.getByRole('main').getByRole('radio', { name: 'Sources' }).check()
    await page
      .getByRole('main')
      .getByRole('link', { name: /^Cell notes/ })
      .click()
    await expect(page.getByRole('heading', { level: 1, name: 'Cell notes' })).toBeVisible()
    await expect(page.getByText('1 suggested card')).toHaveCount(count)
    await page.goto('./#/inbox')
    await expect(page.getByRole('heading', { level: 1, name: 'Suggested cards' })).toBeVisible()
    await expect(page.getByText('What does the mitochondrion produce?')).toHaveCount(count)
    if (!shown) await expect(page.getByText('No card is waiting for your approval.')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    await palette.getByRole('combobox').fill('Suggested')
    await expect(palette.getByRole('option', { name: /Suggested cards/ })).toHaveCount(count)
    await page.keyboard.press('Escape')
  }
  await suggested(true)

  await page.goto('./#/settings/ai')
  const show = page.getByRole('switch', { name: 'Show AI features' })
  await expect(show).toBeChecked()
  await show.click()
  await expect(show).not.toBeChecked()
  await expect(page.getByText('Hidden everywhere, as with no model.')).toBeVisible()
  // The model stays set up: its settings are all still here.
  await expect(page.getByText('How AI runs')).toBeVisible()

  await page.goto('./#/settings')
  await expect(page.getByRole('main').getByRole('link', { name: /^AI/ })).toContainText('Hidden in the app')
  await openCourse(page)
  await noAi(page)
  await page.keyboard.press('ControlOrMeta+j')
  await expect(chat(page)).toHaveCount(0)
  // Kept after a reload: a setting, synced like the others.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
  await noAi(page)

  await suggested(false)
  // Hidden, nothing was deleted: on again, the suggestion is back where it was.
  await page.goto('./#/settings/ai')
  await page.getByRole('switch', { name: 'Show AI features' }).click()
  await openCourse(page)
  await expect(page.getByRole('main').getByRole('button', { name: 'Ask about this' }).first()).toBeVisible()
  await suggested(true)
  expect(errors).toEqual([])
})

test('without a model, a study sheet is written by hand: no AI on its screen, kept in the course', async ({ page }) => {
  const errors = watchErrors(page)
  await harness.seed(page, { courses: [{ title: 'Biology', notes: [{ title: 'Cell notes', body: 'Cells.' }] }] })
  await openCourse(page)
  await page.getByRole('radio', { name: 'Study sheets' }).check({ force: true })
  await page.getByRole('main').getByRole('button', { name: 'New study sheet' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled study sheet' })).toBeVisible()
  await page.getByLabel('Title').fill('Mitosis')
  await page.getByRole('textbox', { name: 'Study sheet' }).click()
  await page.keyboard.type('Four phases.')
  await expect(page.getByRole('heading', { level: 1, name: 'Mitosis' })).toBeVisible()
  await noAi(page)
  await page.getByRole('link', { name: 'Back' }).click()
  await page.getByRole('radio', { name: 'Study sheets' }).check({ force: true })
  await page.getByRole('main').getByRole('link', { name: 'Mitosis' }).click()
  await expect(page.getByRole('textbox', { name: 'Study sheet' })).toContainText('Four phases.')
  expect(errors).toEqual([])
})
