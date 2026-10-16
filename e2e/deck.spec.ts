import { join } from 'node:path'
import { expect, type Page, type Route, test } from '@playwright/test'
import { chatPanel, configureAi } from './support/ai'
import { createCourse } from './support/page'

test.use({ serviceWorkers: 'block' })

const LLM = 'https://llm.mock.test/v1'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}
const DECKS = join(import.meta.dirname, '..', 'tests', 'fixtures', 'content')

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

const hasImage = (body: Body) =>
  body.messages.some((m) => typeof m.content !== 'string' && m.content.some((c) => c.type === 'image_url'))

/** Two questions per unit given (a question and a cloze), named after the unit's title. */
function questionsFor(prompt: string) {
  const questions: Record<string, unknown>[] = []
  for (const m of prompt.matchAll(/<<<UNIT n="(\d+)"[^>]*>>>\n([\s\S]*?)\n<<<END UNIT>>>/g)) {
    const unit = Number(m[1])
    const title = /Title: (.*)/.exec(m[2] ?? '')?.[1]?.trim() ?? `unit ${unit}`
    questions.push(
      { unit, type: 'qa', difficulty: 'easy', front: `What is ${title} about?`, back: `The ${title} slide.` },
      { unit, type: 'cloze', difficulty: 'medium', front: `This unit is about {{c1::${title}}}.`, back: '' },
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

/** Streams `content` in small deltas, as an OpenAI-compatible server would. */
function sse(content: string): string {
  const base = { id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, model: 'claude-haiku-5-5' }
  const events: Record<string, unknown>[] = []
  for (let i = 0; i < content.length; i += 24) {
    const delta =
      i === 0 ? { role: 'assistant', content: content.slice(i, i + 24) } : { content: content.slice(i, i + 24) }
    events.push({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })
  }
  events.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  events.push({ ...base, choices: [], usage: { prompt_tokens: 1200, completion_tokens: 400 } })
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`
}

interface Calls {
  questions: Body[]
}

/** An OpenAI-compatible provider answering the deck-questions call; `hold` keeps those calls pending. */
async function mockProvider(page: Page, o: { hold?: Promise<void> } = {}): Promise<Calls> {
  const calls: Calls = { questions: [] }
  await page.route(`${LLM}/**`, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const body = req.postDataJSON() as Body
    const text = textOf(body)
    if (!text.includes('spaced-repetition questions on course material')) {
      return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', json: completion('OK') })
    }
    calls.questions.push(body)
    if (o.hold) await o.hold
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      json: completion(JSON.stringify(questionsFor(text))),
    })
  })
  // A refreshed catalog where this route reads text only.
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

async function openImport(page: Page, course: string) {
  await page.goto('./#/')
  await createCourse(page, course)
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  // One « Add files » for every format: slides and documents are read in the app.
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'Add a source' }).getByRole('button', { name: 'Add files' }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
}

test('slides: preview, questions for a range of slides, review by slide, saved cards with clickable citations', async ({
  page,
}, info) => {
  const calls = await mockProvider(page)
  await configureAi(page, LLM)
  await openImport(page, 'Biology')

  await page.getByLabel('Add files').setInputFiles(join(DECKS, 'slides.pptx'))
  await expect(page.getByRole('heading', { level: 1, name: 'Cell Biology 101' })).toBeVisible()
  await expect(page.getByText('4 slides')).toBeVisible()
  // Saved as a source of this course, shown first by its content; the original stays one tap away.
  await expect(page.getByRole('link', { name: 'Open the original' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Slide 2 Osmosis' })).toBeVisible()
  await expect(page.getByText('Speaker notes', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Stress that water moves, not solutes.')).toBeVisible()
  await expect(page.getByText('Hidden slide')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Diagram of osmosis' })).toBeVisible()

  // « Create cards » proposes cards on the slides in the chat, through the queue; the slides can be picked by hand too.
  await page.getByRole('button', { name: 'Create cards' }).click()
  const chat = chatPanel(page, info.project.name)
  await expect(chat.getByText(/cards? wait in Suggested cards\./)).toBeVisible()
  await expect(chat.getByRole('link', { name: 'Open Suggested cards' })).toBeVisible()
  const before = calls.questions.length
  await chat.getByRole('link', { name: 'Choose the slides or sections' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Create cards' })).toBeVisible()
  // Hidden slides are left out unless asked for; the range narrows to slides 2–3.
  await expect(page.getByText('3 selected')).toBeVisible()
  await page.getByLabel('From', { exact: true }).selectOption({ label: 'Slide 2 · Osmosis' })
  await page.getByLabel('To', { exact: true }).selectOption({ label: 'Slide 3 · Transport compared' })
  await expect(page.getByText('2 selected')).toBeVisible()
  await expect(page.getByLabel('Language of the cards')).toHaveValue('')
  await expect(page.getByTestId('deck-estimate')).toHaveText(
    /^Estimated cost: \$[\d.]+ · 2 slides · Claude Haiku 5\.5$/,
  )
  // This model sees pictures: no text-only notice.
  await expect(page.getByText(/^This model can’t see pictures/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Create cards' }).click()

  await expect(page.getByTestId('deck-progress')).toHaveText('2 of 2 slides done')
  await expect(page.getByText('4 to check · 0 accepted')).toBeVisible()
  // One request for the slides chosen here.
  expect(calls.questions).toHaveLength(before + 1)
  const sent = textOf(calls.questions.at(-1) as Body)
  expect(sent).toContain('Title: Osmosis')
  expect(sent).toContain('Speaker notes: Stress that water moves, not solutes.')
  expect(sent).not.toContain('Title: Backup')
  expect(hasImage(calls.questions.at(-1) as Body)).toBe(true)

  // One by one: edit, reject (undoable), accept; then all of a slide at once.
  await page.getByLabel('Question 1, Slide 2', { exact: true }).fill('What is osmosis, exactly?')
  await page.getByRole('button', { name: 'Reject card 2, Slide 2' }).click()
  await expect(page.getByText('Rejected:', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Undo rejecting card 2, Slide 2' }).click()
  await page.getByRole('button', { name: 'Reject card 2, Slide 2' }).click()
  await page.getByRole('button', { name: 'Accept card 1, Slide 2' }).click()
  await page.getByRole('button', { name: 'Accept all for Slide 3' }).click()
  await expect(page.getByText('0 to check · 3 accepted')).toBeVisible()

  // The citation opens the slide in the source; the drafts wait on this device meanwhile.
  await page.getByRole('link', { name: 'Slide 2', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Cell Biology 101' })).toBeVisible()
  await expect(page.getByText('Cited: Slide 2')).toBeVisible()
  await expect(page.locator('li[aria-current="location"]')).toContainText('Osmosis')
  await page.goBack()
  await expect(page.getByText('0 to check · 3 accepted')).toBeVisible()
  await expect(page.getByLabel('Question 1, Slide 2', { exact: true })).toHaveValue('What is osmosis, exactly?')

  // Nothing is a card before Save.
  await page.getByRole('button', { name: 'Save 3 cards' }).click()
  await expect(page.getByText('3 cards saved.')).toBeVisible()
  await page.getByRole('link', { name: 'Open course' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
  await expect(page.getByText('What is osmosis, exactly?')).toBeVisible()
  await expect(page.getByText('This unit is about Transport compared.')).toBeVisible()
  await expect(page.getByText('What is Osmosis about?')).toHaveCount(0)
})

test('a study sheet in the chat reads the slides of a deck source and cites the slide, opening it in the source', async ({
  page,
}, info) => {
  await mockProvider(page)
  const prompts: string[] = []
  // Registered last, so it answers first: the explanation call, cited at slide 2; the rest falls through.
  await page.route(`${LLM}/**`, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fallback()
    const body = req.postDataJSON() as Body & { stream?: boolean }
    const text = textOf(body)
    if (!text.includes('patient tutor')) return route.fallback()
    prompts.push(text)
    const deck = /<<<SOURCE id="([^"]+)" page="2">>>/.exec(text)?.[1] ?? 'missing-deck'
    const out = JSON.stringify({
      title: 'Osmosis',
      summary: 'Water moves across a membrane.',
      points: [{ heading: 'Water moves', explanation: 'Not the solutes.', sourceRef: { sourceId: deck, page: 2 } }],
    })
    if (body.stream) {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sse(out) })
    }
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', json: completion(out) })
  })
  await configureAi(page, LLM)
  await openImport(page, 'Biology')
  await page.getByLabel('Add files').setInputFiles(join(DECKS, 'slides.pptx'))
  await expect(page.getByRole('heading', { level: 1, name: 'Cell Biology 101' })).toBeVisible()

  await page.goto('./#/understand')
  const chat = chatPanel(page, info.project.name)
  const fiche = chat.getByRole('article', { name: 'Study sheet' })
  await expect(fiche.getByRole('heading', { name: 'Water moves' })).toBeVisible()
  await chat.getByText('Sources: all of Biology').click()
  await expect(chat.getByRole('checkbox', { name: 'Cell Biology 101' })).toBeChecked()
  await chat.getByLabel('What should the sheet cover?').fill('osmosis')
  await chat.getByRole('button', { name: 'Run again', exact: true }).click()
  await expect.poll(() => prompts.at(-1) ?? '').toContain('Topic: osmosis')
  await expect(chat.getByRole('log')).not.toHaveAttribute('aria-busy', 'true')
  await expect(fiche.getByRole('heading', { name: 'Water moves' })).toBeVisible()
  // The model read the deck slide by slide, each slide numbered for citations.
  expect(prompts.at(-1)).toMatch(/<<<SOURCE id="[^"]+" page="2">>>\nOsmosis\n/)
  expect(prompts.at(-1)).toContain('Speaker notes: Stress that water moves, not solutes.')
  const cite = fiche.getByRole('link', { name: 'Open source: Cell Biology 101 · Slide 2' })
  await expect(cite).toHaveAttribute('href', /#\/source\/[^?]+\?page=2$/)
  await cite.click()
  await expect(page.getByText('Cited: Slide 2')).toBeVisible()
  await expect(page.locator('li[aria-current="location"]')).toContainText('Osmosis')
})

test('a document is saved and readable section by section even without a model; a damaged file saves nothing', async ({
  page,
}) => {
  await openImport(page, 'Physiology')

  await page.getByLabel('Add files').setInputFiles({
    name: 'broken.pptx',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('PK\u0003\u0004 not a deck'),
  })
  await expect(
    page.getByText('This file is damaged and can’t be read. Nothing was saved.', { exact: false }),
  ).toBeVisible()

  await page.getByLabel('Add files').setInputFiles(join(DECKS, 'notes.docx'))
  await expect(page.getByRole('heading', { level: 1, name: 'Physiology notes' })).toBeVisible()
  await expect(page.getByText('6 sections')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Section 1.1 Osmosis' })).toBeVisible()

  // Without a model nothing of the AI shows: the document is saved and read, nothing offers to create cards.
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: 'Create cards' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Suggest cards' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open AI settings' })).toHaveCount(0)

  // The source stayed: one document in the course, read section by section.
  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Physiology/ })
    .first()
    .click()
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await expect(page.getByRole('main').getByRole('link', { name: /broken/ })).toHaveCount(0)
  await page
    .getByRole('main')
    .getByRole('link', { name: /Physiology notes/ })
    .click()
  await expect(page.getByRole('heading', { level: 2, name: 'Section 1.2 Diffusion' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Sodium pump' })).toBeVisible()
  await expect(page.getByText('6 sections')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create cards' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Suggest cards' })).toHaveCount(0)
})

test('a PDF of slides with a text-only model: notice, offline state, stop and resume, then save', async ({
  page,
  context,
}, info) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls = await mockProvider(page, { hold: held })
  await configureAi(page, LLM)
  await page.getByRole('button', { name: 'Refresh catalog' }).click()
  await expect(page.getByText('Catalog updated.')).toBeVisible()
  await openImport(page, 'Cells')

  await page.getByLabel('Add files').setInputFiles(join(DECKS, 'slides.pdf'))
  await expect(page.getByRole('heading', { level: 1, name: 'Cell Biology slides' })).toBeVisible()
  await expect(page.getByText('3 slides')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Slide 3 Active transport' })).toBeVisible()

  // « Create cards » starts the queue in the chat; stopped there, the slides are picked by hand instead.
  await page.getByRole('button', { name: 'Create cards' }).click()
  const chat = chatPanel(page, info.project.name)
  await expect.poll(() => calls.questions.length).toBe(1)
  await chat.getByRole('button', { name: 'Stop' }).click()
  await expect(chat.getByText(/^Stopped/)).toBeVisible()
  await expect(chat.getByRole('button', { name: 'Resume' })).toBeVisible()
  const before = calls.questions.length
  await chat.getByRole('link', { name: 'Choose the slides or sections' }).click()
  await expect(page.getByText(/^This model can’t see pictures: the cards come from the text/)).toBeVisible()
  await page.getByRole('radio', { name: '1', exact: true }).check({ force: true })

  // Offline: the document is there, creating questions waits for a connection.
  await context.setOffline(true)
  await expect(page.getByText(/^You’re offline\. Your document is saved/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create cards' })).toBeDisabled()
  await context.setOffline(false)
  await expect(page.getByRole('button', { name: 'Create cards' })).toBeEnabled()

  await page.getByRole('button', { name: 'Create cards' }).click()
  await expect(page.getByTestId('deck-progress')).toHaveText('0 of 3 slides done')
  await expect.poll(() => calls.questions.length).toBe(before + 1)
  expect(hasImage(calls.questions.at(-1) as Body)).toBe(false)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText(/^Stopped\. What was done is kept on this device/)).toBeVisible()
  await expect(page.getByText('Not done yet')).toHaveCount(3)

  // The stopped call is dropped; a fresh provider answers from now on.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  release()
  await mockProvider(page)
  // Resume, even after leaving the screen: the run waits on this device.
  await page.reload()
  await expect(page.getByTestId('deck-progress')).toHaveText('0 of 3 slides done')
  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByTestId('deck-progress')).toHaveText('3 of 3 slides done')
  await expect(
    page.getByText('The model couldn’t see the pictures: these cards come from the text and speaker notes only.'),
  ).toBeVisible()
  await expect(page.getByText('3 to check · 0 accepted')).toBeVisible()
  await page.getByRole('button', { name: 'Accept all', exact: true }).click()
  await page.getByRole('button', { name: 'Save 3 cards' }).click()
  await expect(page.getByText('3 cards saved.')).toBeVisible()
})

test('a PDF kept as a mere file is read in the app in place: same source, notes kept', async ({ page }) => {
  await openImport(page, 'Anatomy')
  // The PDF reader fails to load at import: the PDF is still kept, as a file to open in the system viewer.
  await page.route('**/pdf.worker*', (route) => route.abort())
  await page.getByLabel('Add files').setInputFiles(join(DECKS, 'slides.pdf'))
  await expect(page.getByRole('heading', { level: 1, name: 'slides' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open PDF' })).toBeVisible()
  const notes = page.getByRole('textbox', { name: 'Notes' })
  await notes.click()
  await page.keyboard.type('Pumps need ATP.')
  // The reader loads again on a fresh page (a failed module load is remembered by the page).
  await page.unroute('**/pdf.worker*')
  await page.waitForTimeout(300)
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Notes' })).toContainText('Pumps need ATP.')

  await page.getByRole('button', { name: 'Read this PDF in the app' }).click()
  await expect(page.getByText('3 slides')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Slide 3 Active transport' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open the original' })).toHaveAttribute('href', /^blob:/)
  await expect(page.getByRole('button', { name: 'Read this PDF in the app' })).toHaveCount(0)
  await expect(page.getByText('My notes')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Notes' })).toContainText('Pumps need ATP.')

  // Converted in place: still one source in the course.
  await page.getByRole('link', { name: 'Back' }).click()
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await expect(page.getByRole('main').getByRole('link', { name: /slides/ })).toHaveCount(1)
})
