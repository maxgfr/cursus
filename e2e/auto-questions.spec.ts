import { join } from 'node:path'
import { expect, type Page, type Route, test } from '@playwright/test'
import { configureAi } from './support/ai'
import { createCourse, go } from './support/page'

// Questions proposed automatically when a document is added (« When I add a document »): proposals arrive in
// « To review », grouped by document and slide, then accepted, edited or rejected; « Do nothing » and « Add them
// directly » respected; a document over a cost cap waits for approval with its estimate; offline it waits for a
// connection; Today says how many wait. The provider is intercepted.
test.use({ serviceWorkers: 'block' })

const LLM = 'https://llm.mock.test/v1'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}
const DECKS = join(import.meta.dirname, '..', 'tests', 'fixtures', 'content')
const FIXTURES = join(import.meta.dirname, 'fixtures')

interface Part {
  type: string
  text?: string
}
interface Body {
  messages: { role: string; content: string | Part[] }[]
}

const textOf = (body: Body) =>
  body.messages
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((c) => c.text ?? '').join('\n')))
    .join('\n')

/** Two questions per unit given (a question and a cloze), named after the unit's title. */
function questionsFor(prompt: string) {
  const questions: Record<string, unknown>[] = []
  for (const m of prompt.matchAll(/<<<UNIT n="(\d+)"[^>]*>>>\n([\s\S]*?)\n<<<END UNIT>>>/g)) {
    const unit = Number(m[1])
    const title = /Title: (.*)/.exec(m[2] ?? '')?.[1]?.trim() ?? `unit ${unit}`
    questions.push(
      { unit, type: 'qa', difficulty: 'easy', front: `What is ${title} about?`, back: `The ${title} part.` },
      { unit, type: 'cloze', difficulty: 'medium', front: `This part is about {{c1::${title}}}.`, back: '' },
    )
  }
  return { questions }
}

function completion(content: string) {
  return {
    id: 'cmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'claude-haiku-5-5',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1200, completion_tokens: 400 },
  }
}

/** An OpenAI-compatible provider answering the questions call, and a catalog where the model reads text only. */
async function mockProvider(page: Page): Promise<Body[]> {
  const calls: Body[] = []
  await page.route(`${LLM}/**`, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const body = req.postDataJSON() as Body
    const text = textOf(body)
    if (!text.includes('spaced-repetition questions on course material')) {
      return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', json: completion('OK') })
    }
    calls.push(body)
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      json: completion(JSON.stringify(questionsFor(text))),
    })
  })
  await page.route('https://models.dev/api.json', (route) =>
    route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      json: {
        '302ai': {
          id: '302ai',
          name: '302.AI',
          npm: '@ai-sdk/openai-compatible',
          api: 'https://api.302.ai/v1',
          models: {
            'claude-haiku-5-5': {
              id: 'claude-haiku-5-5',
              name: 'Claude Haiku 5.5',
              limit: { context: 1_000_000, output: 128_000 },
              cost: { input: 0.1, output: 0.5 },
              modalities: { input: ['text'] },
              structured_output: true,
              release_date: '2026-10-07',
            },
          },
        },
      },
    }),
  )
  return calls
}

/** AI set up through the settings, with the catalog refreshed (the model reads text only: no page is drawn). */
async function setUpAi(page: Page) {
  await configureAi(page, LLM)
  await page.getByRole('button', { name: 'Refresh catalog' }).click()
  await expect(page.getByText('Catalog updated.')).toBeVisible()
}

async function newCourse(page: Page, title: string) {
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await createCourse(page, title)
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
}

async function importPdf(page: Page, file: string, title: string) {
  await page.getByLabel('Add files').setInputFiles(file)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

const doc = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true })

test('adding a PDF proposes questions; they are reviewed by slide and the accepted ones saved as cards', async ({
  page,
}) => {
  const calls = await mockProvider(page)
  await setUpAi(page)
  // The one visible setting, proposing by default; the rest is folded.
  await expect(page.getByRole('radio', { name: 'Suggest cards' })).toBeChecked()
  await expect(page.getByLabel('Limit per document (USD)')).toBeHidden()

  await newCourse(page, 'Physiology')
  await importPdf(page, join(DECKS, 'slides.pdf'), 'Cell Biology slides')
  await expect(page.getByText('6 suggested cards')).toBeVisible()
  expect(calls).toHaveLength(1)
  // By default the AI decides how many cards each slide deserves, within a cap.
  expect(textOf(calls[0] as Body)).toContain('decide how many questions it deserves, from 0 to 10')

  // Today: one calm line, and the way to the review.
  await go(page, '#/', 'Today')
  // Nothing due yet: the suggested cards are the main action.
  const hero = page.getByTestId('drafts-hero')
  await expect(hero.getByRole('heading', { level: 2 })).toHaveText('6 cards suggested from Physiology')
  await hero.getByRole('link', { name: 'Accept or edit' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Suggested cards' })).toBeVisible()

  // Grouped by document, then by slide; edit, reject (undoable until saved), accept one, then all of a slide.
  const slides = doc(page, 'Cell Biology slides')
  await expect(slides.getByText('In Physiology')).toBeVisible()
  await expect(slides.getByText('6 to check · 0 accepted')).toBeVisible()
  await expect(slides.getByRole('heading', { name: /^Slide 3 Active transport$/ })).toBeVisible()
  await slides.getByLabel('Question 1, Slide 1', { exact: true }).fill('What does the first slide cover?')
  await slides.getByRole('button', { name: 'Reject card 2, Slide 1' }).click()
  await slides.getByRole('button', { name: 'Undo rejecting card 2, Slide 1' }).click()
  await slides.getByRole('button', { name: 'Reject card 2, Slide 1' }).click()
  await slides.getByRole('button', { name: 'Accept card 1, Slide 1' }).click()
  await slides.getByRole('button', { name: 'Accept all for Slide 2' }).click()
  await expect(slides.getByText('2 to check · 3 accepted')).toBeVisible()
  await expect(page.getByText('Rejected cards won’t be suggested again.')).toBeVisible()
  await page.getByRole('button', { name: 'Save 3 cards' }).click()
  await expect(page.getByText('3 cards saved.')).toBeVisible()
  await expect(slides.getByText('2 to check · 0 accepted')).toBeVisible()

  await go(page, '#/', 'Today')
  await expect(page.getByTestId('drafts-line')).toHaveText('2 cards suggested from Physiology · Accept or edit')

  // The cards are in the course; asked again, the document brings back neither a rejected nor a known question.
  await page
    .getByRole('main')
    .getByRole('link', { name: /Physiology/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Physiology' })).toBeVisible()
  await expect(page.getByText('What does the first slide cover?')).toBeVisible()
  await expect(page.getByTestId('course-drafts')).toHaveText('2 suggested cards · Accept or edit')
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Cell Biology slides/ })
    .click()
  await page.getByRole('button', { name: 'Suggest cards' }).click()
  await expect.poll(() => calls.length).toBe(2)
  await expect(page.getByRole('button', { name: 'Suggest cards' })).toBeEnabled()
  await expect(page.getByText('2 suggested cards')).toBeVisible()
})

test('« Do nothing » proposes nothing; « Add them directly » puts the questions straight into the course', async ({
  page,
}) => {
  const calls = await mockProvider(page)
  await setUpAi(page)
  await page.getByRole('radio', { name: 'Do nothing' }).check({ force: true })
  await expect(page.getByText('Nothing happens on its own.', { exact: false })).toBeVisible()

  await newCourse(page, 'Botany')
  await importPdf(page, join(DECKS, 'slides.pdf'), 'Cell Biology slides')
  await expect(page.getByRole('button', { name: 'Suggest cards' })).toBeEnabled()
  await go(page, '#/inbox', 'Suggested cards')
  await expect(page.getByRole('heading', { name: 'No suggested cards' })).toBeVisible()
  await expect(page.getByText('Cards aren’t suggested when you add a document', { exact: false })).toBeVisible()
  expect(calls).toHaveLength(0)

  // Added directly: a note written in the course becomes cards as soon as it is left.
  await go(page, '#/settings/ai', 'AI')
  await page.getByRole('radio', { name: 'Add them directly' }).check({ force: true })
  await page.getByRole('main').getByRole('link', { name: 'Back' }).click()
  await go(page, '#/courses', 'Courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Botany/ })
    .first()
    .click()
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: 'Write a note' }).click()
  await page.getByRole('textbox', { name: 'Source' }).click()
  await page.keyboard.type('Roots drink water. Leaves catch light.')
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Botany' })).toBeVisible()
  await expect(page.getByText('What is Untitled note about?')).toBeVisible()
  await expect(page.getByText('This part is about {{c1::Untitled note}}.')).toBeVisible()
  await expect(page.getByTestId('course-drafts')).toHaveCount(0)
  expect(calls).toHaveLength(1)
})

test('over the cost cap a document waits for approval with its estimate; offline it waits for a connection', async ({
  page,
  context,
}) => {
  const calls = await mockProvider(page)
  await setUpAi(page)
  await page.locator('summary', { hasText: /^Advanced$/ }).click()
  // The count per slide is automatic unless chosen here.
  await expect(page.getByLabel('Cards per page, slide or section')).toHaveValue('auto')
  await expect(
    page.getByText(/^Above a limit, a document waits for your approval.* Spent this month: \$/),
  ).toBeVisible()
  const cap = page.getByLabel('Limit per document (USD)')
  await expect(cap).toHaveValue('0.2')
  await cap.fill('0')
  await cap.press('Enter')

  await newCourse(page, 'Cells')
  await importPdf(page, join(DECKS, 'slides.pdf'), 'Cell Biology slides')
  await go(page, '#/inbox', 'Suggested cards')
  const slides = doc(page, 'Cell Biology slides')
  await expect(
    slides.getByText(/^About \$0\.\d+ for this document, above your limit of \$0\.00 per document\.$/),
  ).toBeVisible()
  expect(calls).toHaveLength(0)
  await slides.getByRole('button', { name: /^Allow \$0\.\d+$/ }).click()
  await expect(slides.getByText('6 to check · 0 accepted')).toBeVisible()
  expect(calls).toHaveLength(1)

  // Offline: the document is saved and waits, saying why; back online, it goes on (still within its cap).
  await go(page, '#/courses', 'Courses')
  await page.getByRole('main').getByRole('link', { name: /Cells/ }).first().click()
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await context.setOffline(true)
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false)
  await importPdf(page, join(FIXTURES, 'sample.pdf'), 'sample')
  await go(page, '#/inbox', 'Suggested cards')
  const sample = doc(page, 'sample')
  await expect(sample.getByText('Waiting for a connection: the cards come once you’re back online.')).toBeVisible()
  await context.setOffline(false)
  // Service workers are blocked here, so the PDF reader that failed to load offline loads on a fresh page; with
  // the app's service worker it is cached and loads offline too.
  await page.reload()
  await expect(sample.getByText(/^About \$0\.\d+ for this document, above your limit/)).toBeVisible()
  await sample.getByRole('button', { name: /^Allow \$0\.\d+$/ }).click()
  await expect(sample.getByText(/^\d+ to check · 0 accepted$/)).toBeVisible()
  expect(calls).toHaveLength(2)
})

test('without a model the documents wait with a discreet invitation; slides and documents are named as such', async ({
  page,
}) => {
  const calls = await mockProvider(page)
  await newCourse(page, 'Anatomy')
  await page.getByLabel('Add files').setInputFiles(join(DECKS, 'notes.docx'))
  await expect(page.getByRole('heading', { level: 1, name: 'Physiology notes' })).toBeVisible()
  await page.getByRole('link', { name: 'Back' }).click()
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page.getByLabel('Add files').setInputFiles(join(DECKS, 'slides.pptx'))
  await expect(page.getByRole('heading', { level: 1, name: 'Cell Biology 101' })).toBeVisible()

  // The course lists a .docx as a document and a .pptx as slides, not as notes.
  await go(page, '#/courses', 'Courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Anatomy/ })
    .first()
    .click()
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await expect(page.getByRole('main').getByRole('link', { name: /Physiology notes/ })).toContainText('Document')
  await expect(page.getByRole('main').getByRole('link', { name: /Cell Biology 101/ })).toContainText('Slides')

  await go(page, '#/inbox', 'Suggested cards')
  await expect(
    page.getByText('Cards are suggested from the documents you add once an AI model is set up.'),
  ).toBeVisible()
  await expect(doc(page, 'Physiology notes').getByText('Waiting for an AI model.')).toBeVisible()
  expect(calls).toHaveLength(0)

  // Once a model is set up, the waiting documents get their questions.
  await setUpAi(page)
  await go(page, '#/inbox', 'Suggested cards')
  await expect(doc(page, 'Physiology notes').getByText(/^\d+ to check · 0 accepted$/)).toBeVisible()
  await expect(doc(page, 'Cell Biology 101').getByText(/^\d+ to check · 0 accepted$/)).toBeVisible()
  await expect(
    page.getByText('Cards are suggested from the documents you add once an AI model is set up.'),
  ).toHaveCount(0)
})
