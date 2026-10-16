import { expect, type Page, type Route, test } from '@playwright/test'
import { completionReply, configureAi } from './support/ai'
import { createHarness } from './support/harness.ts'
import { isPhone, putKv } from './support/page.ts'

// « Explain the question » and « Why? » against an intercepted provider, streamed into the chat's thread: before
// the reveal nothing shown gives the answer away (redacted fields, citations as bare links, « Show anyway »); after
// it everything shows, and the thread goes on with a follow-up. A term
// selected in the card or in a source is asked about in the chat, which knows the screen and keeps the answer
// hidden as long as the card does; its answer becomes a card.
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

const NOTE_BODY = 'The mitochondrion produces ATP through cellular respiration.\n\nRibosomes build proteins.'
const PASSAGE = 'produces ATP through cellular respiration'

/** One course, one note, one new card whose answer ("mitochondrion") the note names too. */
async function seedCourse(page: Page) {
  await harness.seed(page, {
    courses: [
      {
        title: 'Biology',
        notes: [{ title: 'Cell notes', body: NOTE_BODY }],
        cards: [{ front: 'Powerhouse of the cell?', back: 'The mitochondrion' }],
      },
    ],
  })
}

interface Body {
  stream?: boolean
  messages: { role: string; content: string | { type: string; text?: string }[] }[]
}

function textOf(body: Body): string {
  return body.messages
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((c) => c.text ?? '').join('')))
    .join('\n')
}

const noteId = (prompt: string) => /<<<SOURCE id="([^"]+)">>>/.exec(prompt)?.[1] ?? 'missing-note'

/** The question explained by a model that names the answer anyway, in its context. */
function questionExplanation(prompt: string) {
  const note = noteId(prompt)
  return {
    restatement: 'It asks which part of the cell releases most of its energy.',
    terms: [
      {
        term: 'Powerhouse',
        definition: 'A picture for the place where energy is made.',
        sourceRef: { sourceId: note },
      },
    ],
    context: 'The mitochondrion is where cellular respiration happens in your notes.',
    citations: [{ sourceId: note }],
  }
}

/** The tutor's answer to a selected term: it names the card's answer and cites the note. */
function tutorAnswer(prompt: string): string {
  const term = /What does “([^”]+)” mean here\?/.exec(prompt)?.[1] ?? 'it'
  return `**${term}** is where the mitochondrion comes in [[source:${noteId(prompt)}]]: it releases the cell's energy.`
}

async function mockProvider(page: Page): Promise<string[]> {
  const prompts: string[] = []
  await page.route(`${LLM}/**`, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const text = textOf(req.postDataJSON() as Body)
    prompts.push(text)
    let content = 'OK'
    if (text.includes('asks what the question means')) content = JSON.stringify(questionExplanation(text))
    else if (text.includes('asks why it is the answer'))
      content = JSON.stringify({
        explanation: 'Respiration runs in the mitochondrion, which is why it **makes the ATP**.',
        mnemonic: 'Mighty mitochondria',
        citations: [{ sourceId: noteId(text) }],
      })
    else if (text.includes('study tutor')) content = tutorAnswer(text)
    // Streamed, as the screens ask for it: the explanation and the chat are read as they are written.
    return route.fulfill(completionReply(req, content, CORS))
  })
  return prompts
}

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

/** Selects `word` in the first text node under `container` that holds it, as a long press or a drag would. */
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

async function openReview(page: Page) {
  await page.goto('./#/review')
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible()
  await expect(page.getByTestId('question')).toContainText('Powerhouse of the cell?')
}

async function openNote(page: Page) {
  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page
    .getByRole('main')
    .getByRole('link', { name: /Cell notes/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Cell notes' })).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('produces ATP')
}

/** The chat: docked beside the page from 1000px, a sheet on phones. */
function chatPanel(page: Page, project: string) {
  return isPhone(project) ? page.getByRole('dialog', { name: 'Ask' }) : page.getByRole('complementary', { name: 'Ask' })
}

/** The review's own buttons, not the chat's actions of the same name. */
const reviewButton = (page: Page, name: string) => page.getByRole('main').getByRole('button', { name, exact: true })

/** What a review button opened, right below the card. */
const assist = (page: Page, name: string) => page.getByRole('main').getByRole('region', { name, exact: true })

test('before the reveal the question is explained below the card without its answer; after it, everything shows', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openReview(page)

  await reviewButton(page, 'Explain the question').click()
  const sheet = assist(page, 'Explain the question')
  await expect(sheet.getByText('It asks which part of the cell releases most of its energy.')).toBeVisible()
  // The model was told the answer only to avoid it, and was given the question alone to search the sources.
  expect(prompts.at(-1)).toContain('Answer (keep hidden): The mitochondrion')
  expect(prompts.at(-1)).toContain('The student has NOT seen the answer yet')

  // The context named the answer: it shows redacted, saying why, with a way to see it anyway.
  await expect(sheet.getByText('The […] is where cellular respiration happens in your notes.')).toBeVisible()
  await expect(sheet.getByText('Hidden: it gives the answer away.')).toBeVisible()
  await expect(sheet).not.toContainText(/mitochondri/i)
  // Citations are links to the cited source, without the passage (which names the answer too).
  await expect(sheet.getByRole('link', { name: 'Open source: Cell notes' })).toHaveCount(2)
  await expect(sheet.getByRole('link', { name: 'Open source: Cell notes' }).first()).toHaveAttribute(
    'href',
    /#\/source\//,
  )
  await expect(sheet).not.toContainText(PASSAGE)
  await expect(sheet.getByText(/Estimated cost: \$/)).toBeVisible()

  // « Show anyway » reveals that field, and only that one.
  await sheet.getByRole('button', { name: 'Show anyway' }).click()
  await expect(sheet.getByText('The mitochondrion is where cellular respiration happens in your notes.')).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Show anyway' })).toHaveCount(0)
  await expect(sheet).not.toContainText(PASSAGE)

  // After the reveal the same explanation shows in full, cited passages included, without asking again.
  const asked = prompts.length
  await page.getByRole('button', { name: /Show answer/ }).click()
  await expect(page.getByTestId('answer')).toContainText('The mitochondrion')
  await reviewButton(page, 'Explain the question').click()
  await expect(sheet.getByText('The mitochondrion is where cellular respiration happens in your notes.')).toBeVisible()
  await expect(sheet.getByText('Hidden: it gives the answer away.')).toHaveCount(0)
  await expect(sheet.getByRole('blockquote')).toContainText(PASSAGE)
  expect(prompts.length).toBe(asked)
  expect(errors).toEqual([])
})

test('after the reveal, « Why? » explains the answer from the course below the card, cited, and goes on in the chat', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openReview(page)
  // Before the reveal there is nothing to explain the answer of.
  await expect(page.getByRole('button', { name: 'Why?' })).toHaveCount(0)
  await page.getByRole('button', { name: /Show answer/ }).click()
  await reviewButton(page, 'Why?').click()
  const why = assist(page, 'Why?')
  await expect(why.locator('strong', { hasText: 'makes the ATP' })).toBeVisible()
  await expect(why.getByText('Mighty mitochondria')).toBeVisible()
  // Grounded in the course like « Explain the question »: the card as data, the note sent and cited.
  expect(prompts.at(-1)).toContain('Course: Biology')
  expect(prompts.at(-1)).toContain('<<<SOURCE id=')
  await expect(why.getByRole('link', { name: 'Open source: Cell notes' })).toBeVisible()
  await expect(why.getByRole('blockquote')).toContainText(PASSAGE)

  // Continued in the chat: the tutor is given the explanation as what the student is asking about.
  await why.getByRole('button', { name: 'Continue in the chat' }).click()
  const chat = chatPanel(page, info.project.name)
  await expect(chat.getByText(/releases the cell's energy/)).toBeVisible()
  expect(prompts.at(-1)).toContain('study tutor')
  expect(prompts.at(-1)).toContain('Respiration runs in the mitochondrion')
  await expect(why.locator('strong', { hasText: 'makes the ATP' })).toBeVisible()
  expect(errors).toEqual([])
})

test('a term selected in the question is asked about in the chat, without the answer until the reveal', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openReview(page)

  // No generic « Explain a concept »: a term of the card is asked about once selected.
  await expect(page.getByRole('button', { name: 'Explain a concept' })).toHaveCount(0)
  await selectText(page, '[data-testid="question"]', 'cell')
  await page.getByRole('button', { name: 'Ask about “cell”' }).click()
  const panel = chatPanel(page, info.project.name)
  await expect(panel.getByText('What does “cell” mean here?')).toBeVisible()
  await expect(panel.getByText(/releases the cell's energy/)).toBeVisible()
  // The chat knew the card and the line the term was read in, and was told to keep the answer.
  expect(prompts.at(-1)).toContain('Passage the student selected a term in: Powerhouse of the cell?')
  expect(prompts.at(-1)).toContain('Flashcard answer (keep hidden): The mitochondrion')
  // The answer named the card's answer: hidden until the reveal.
  await expect(panel).not.toContainText(/mitochondri/i)
  await expect(panel.getByText('Parts that would give the answer away are hidden until you reveal it.')).toBeVisible()

  if (isPhone(info.project.name)) await panel.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /Show answer/ }).click()
  if (isPhone(info.project.name)) await page.getByRole('main').getByRole('button', { name: 'Ask about this' }).click()
  await expect(panel.getByText(/where the mitochondrion comes in/)).toBeVisible()
  await panel.getByRole('button', { name: 'Make a card' }).click()
  await expect(panel.getByText('Added to Suggested cards.')).toBeVisible()
  expect(errors).toEqual([])
})

test('a term selected in a source is asked about in the chat, cited, and becomes a suggested card', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openNote(page)

  await expect(page.getByRole('button', { name: /^Ask about “/ })).toHaveCount(0)
  await selectText(page, '.cm-content', 'ATP')
  await page.getByRole('button', { name: 'Ask about “ATP”' }).click()
  const panel = chatPanel(page, info.project.name)
  await expect(panel.getByText('About: Cell notes')).toBeVisible()
  await expect(panel.getByText(/releases the cell's energy/)).toBeVisible()
  // The source open and the line the term was read in went along; outside a review nothing is hidden.
  expect(prompts.at(-1)).toContain('Source open: Cell notes')
  expect(prompts.at(-1)).toMatch(/Passage the student selected a term in: The mitochondrion produces ATP/)
  await expect(panel.locator('strong', { hasText: 'ATP' })).toBeVisible()
  await expect(panel.getByRole('link', { name: 'Open source: Cell notes' })).toBeVisible()

  await panel.getByRole('button', { name: 'Make a card' }).click()
  await expect(panel.getByText('Added to Suggested cards.')).toBeVisible()
  if (isPhone(info.project.name)) await panel.getByRole('button', { name: 'Close' }).click()
  await page.goto('./#/inbox')
  await expect(page.getByRole('main').getByText('What does “ATP” mean here?')).toBeVisible()
  expect(errors).toEqual([])
})

test('a whole passage selected in a source is still asked about, as a passage', async ({ page }, info) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openNote(page)

  // Too long for a term: the button stays, short, and the whole passage goes to the chat.
  const sentence = 'The mitochondrion produces ATP through cellular respiration.'
  await selectText(page, '.cm-content', sentence)
  await expect(page.getByRole('button', { name: /^Ask about “/ })).toHaveCount(0)
  const ask = page.getByRole('button', { name: 'Ask about this passage' })
  await expect(ask).toBeInViewport()
  await ask.click()
  const panel = chatPanel(page, info.project.name)
  await expect(panel.getByText('Explain this passage.')).toBeVisible()
  await expect(panel.getByText(/releases the cell's energy/)).toBeVisible()
  expect(prompts.at(-1)).toContain(sentence)
  expect(errors).toEqual([])
})

test('without a model review offers no explanation and a term selected in a source offers nothing', async ({
  page,
}, info) => {
  await seedCourse(page)
  await openReview(page)
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  await expect(reviewButton(page, 'Explain the question')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Ask about “/ })).toHaveCount(0)

  await openNote(page)
  await page.waitForLoadState('networkidle')
  await selectText(page, '.cm-content', 'ATP')
  await expect(page.getByRole('button', { name: /^Ask about/ })).toHaveCount(0)
  await expect(chatPanel(page, info.project.name)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Set up AI' })).toHaveCount(0)
})

test('offline the explanations are disabled, saying why', async ({ page, context }) => {
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  await openReview(page)
  await expect(reviewButton(page, 'Explain the question')).toBeEnabled()
  await context.setOffline(true)
  await expect(reviewButton(page, 'Explain the question')).toBeDisabled()
  await selectText(page, '[data-testid="question"]', 'cell')
  await expect(page.getByRole('button', { name: 'Ask about “cell”' })).toBeDisabled()
  await expect(page.getByText('You’re offline. Explanations need a connection.')).toBeVisible()
  await context.setOffline(false)
  await expect(reviewButton(page, 'Explain the question')).toBeEnabled()
})

/** Stores, on this device, a conversation of Biology where the chat explained the card (« Why? »), citing the note. */
async function keepEarlierWhy(page: Page) {
  await openNote(page)
  const noteId = decodeURIComponent(/#\/source\/([^/?]+)/.exec(page.url())?.[1] ?? '')
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
  const courseId = decodeURIComponent(/#\/course\/([^/?]+)/.exec(page.url())?.[1] ?? '')
  expect(noteId).not.toBe('')
  expect(courseId).not.toBe('')
  const card = { front: 'Powerhouse of the cell?', back: 'The mitochondrion' }
  const why = {
    role: 'assistant',
    text: 'Respiration runs in the mitochondrion.',
    rich: {
      kind: 'explainCard',
      card,
      value: {
        explanation: 'Respiration runs in the mitochondrion, which is why it **makes the ATP**.',
        mnemonic: 'Mighty mitochondria',
        citations: [{ sourceId: noteId }],
      },
    },
  }
  const chat = {
    id: 'earlier',
    title: 'Why is this the answer?',
    updatedAt: Date.now(),
    messages: [{ role: 'user', text: 'Why is this the answer?' }, why],
  }
  await putKv(page, `ai:chat:${courseId}`, { v: 1, chats: [chat] })
  await openReview(page)
}

test('a « Why? » kept in an earlier thread is guarded again when the card comes back unrevealed', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  // A thread kept from when the chat explained cards itself.
  await keepEarlierWhy(page)

  // Later, the same card on screen unrevealed, and that conversation reopened.
  await page.reload()
  await expect(page.getByTestId('question')).toContainText('Powerhouse of the cell?')
  await expect(page.getByRole('button', { name: /Show answer/ })).toBeVisible()
  await page.getByRole('main').getByRole('button', { name: 'Ask about this' }).first().click()
  const panel = chatPanel(page, info.project.name)
  await panel.getByRole('button', { name: 'Earlier chats' }).click()
  await panel.getByRole('button', { name: 'Open “Why is this the answer?”' }).click()
  // The stored explanation names the answer: redacted, with « Show anyway »; citations without their passage.
  await expect(panel.getByText('Hidden: it gives the answer away.').first()).toBeVisible()
  await expect(panel).not.toContainText(/mitochondri/i)
  await expect(panel.getByRole('link', { name: 'Open source: Cell notes' })).toBeVisible()
  await expect(panel).not.toContainText(PASSAGE)

  // Once revealed again, it shows in full.
  if (isPhone(info.project.name)) await panel.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /Show answer/ }).click()
  if (isPhone(info.project.name)) await page.getByRole('main').getByRole('button', { name: 'Ask about this' }).click()
  await expect(panel.getByText('Mighty mitochondria')).toBeVisible()
  await expect(panel.getByRole('blockquote')).toContainText(PASSAGE)
  expect(errors).toEqual([])
})

test('after the reveal, « Explain the question » still explains the question', async ({ page }) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openReview(page)
  await page.getByRole('button', { name: /Show answer/ }).click()
  await expect(page.getByTestId('answer')).toContainText('The mitochondrion')
  await reviewButton(page, 'Explain the question').click()
  const panel = assist(page, 'Explain the question')
  await expect(panel.getByText('It asks which part of the cell releases most of its energy.')).toBeVisible()
  expect(prompts.at(-1)).toContain('asks what the question means')
  await expect(panel.getByText('The mitochondrion is where cellular respiration happens in your notes.')).toBeVisible()
  expect(errors).toEqual([])
})
