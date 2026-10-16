import { expect, type Locator, type Page, type Route, test } from '@playwright/test'
import { configureAi } from './support/ai'
import { createHarness } from './support/harness.ts'
import { isPhone, seriousViolations } from './support/page.ts'

// The chat beside every screen, against an intercepted provider that streams its answers: it knows what is on
// screen (a course, a source, a card), cites the course's sources, never gives a hidden answer away, keeps its
// conversations on the device, and fills the screen on phones.
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

/** An OpenAI-compatible stream of `deltas`, as the provider sends a streamed chat completion. */
function sse(deltas: string[]): string {
  const chunk = (delta: object, finish: string | null, usage?: object) => ({
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'claude-haiku-5-5',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })
  const parts = [
    chunk({ role: 'assistant', content: '' }, null),
    ...deltas.map((content) => chunk({ content }, null)),
    chunk({}, 'stop', { prompt_tokens: 900, completion_tokens: 60 }),
  ]
  return `${parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')}data: [DONE]\n\n`
}

/** The tutor names the answer and cites the note (and an id it made up, which must not show). */
async function mockProvider(page: Page): Promise<string[]> {
  const prompts: string[] = []
  await page.route(`${LLM}/**`, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const body = req.postDataJSON() as Body
    const text = textOf(body)
    prompts.push(text)
    // The study actions answer in structure: cards suggested on a source (one already in the course), a quiz.
    const structured = text.includes('spaced-repetition questions on course material')
      ? JSON.stringify({
          questions: [
            { unit: 1, type: 'qa', difficulty: 'easy', front: 'Which organelle makes ATP?', back: 'The mitochondrion' },
            { unit: 1, type: 'qa', difficulty: 'easy', front: 'Powerhouse of the cell?', back: 'The mitochondrion' },
            { unit: 1, type: 'qa', difficulty: 'easy', front: 'What do ribosomes build?', back: 'Proteins' },
          ],
        })
      : text.includes('patient tutor')
        ? JSON.stringify({
            title: 'Cells',
            summary: 'The mitochondrion makes the cell’s energy.',
            points: [
              { heading: 'Energy', explanation: 'ATP comes from respiration.', sourceRef: { sourceId: noteId(text) } },
            ],
          })
        : text.includes('flashcards')
          ? JSON.stringify({
              cards: [
                { kind: 'basic', front: 'Which organelle makes ATP?', back: 'The mitochondrion' },
                { kind: 'basic', front: 'Powerhouse of the cell?', back: 'The mitochondrion' },
                { kind: 'basic', front: 'What do ribosomes build?', back: 'Proteins' },
              ],
            })
          : text.includes('multiple-choice')
            ? JSON.stringify({
                questions: [
                  {
                    question: 'Which organelle makes ATP?',
                    choices: ['The mitochondrion', 'The ribosome'],
                    answerIndex: 0,
                    explanation: 'Respiration runs there.',
                  },
                  {
                    question: 'What do ribosomes build?',
                    choices: ['Lipids', 'Proteins'],
                    answerIndex: 1,
                    explanation: 'Proteins.',
                  },
                ],
              })
            : null
    if (structured !== null) {
      if (body.stream === true) {
        return route.fulfill({ status: 200, headers: CORS, contentType: 'text/event-stream', body: sse([structured]) })
      }
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        json: {
          id: 'cmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'claude-haiku-5-5',
          choices: [{ index: 0, message: { role: 'assistant', content: structured }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        },
      })
    }
    if (body.stream === true && text.includes('study tutor')) {
      const note = noteId(text)
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'cache-control': 'no-cache' },
        contentType: 'text/event-stream',
        body: sse([
          'Your notes say the mitochondrion ',
          `produces ATP [[source:${note}]]`,
          ' through respiration [[source:INVENTED]].',
          '\n\n- **Key idea**: respiration releases energy',
        ]),
      })
    }
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
  return prompts
}

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

/** The chat: docked beside the page from 1000px, a full-screen dialog on phones. */
function chatPanel(page: Page, project: string): Locator {
  return isPhone(project) ? page.getByRole('dialog', { name: 'Ask' }) : page.getByRole('complementary', { name: 'Ask' })
}

async function openChat(page: Page) {
  await page.getByRole('main').getByRole('button', { name: 'Ask about this' }).first().click()
}

async function ask(panel: Locator, question: string) {
  await panel.getByRole('textbox', { name: 'Your question' }).fill(question)
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
}

async function openCourse(page: Page) {
  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
}

test('from a course: the chat knows the course, streams a cited answer and its citation opens the source', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openCourse(page)

  await openChat(page)
  const panel = chatPanel(page, info.project.name)
  await expect(panel).toBeVisible()
  await expect(panel.getByText('About: Biology')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Quiz me' })).toBeVisible()

  await ask(panel, 'Where is ATP made?')
  await expect(panel.getByText(/Your notes say the mitochondrion produces ATP/)).toBeVisible()
  const sent = prompts.at(-1) ?? ''
  expect(sent).toContain('Course: Biology')
  expect(sent).toContain('Where is ATP made?')
  expect(sent).toContain('<<<SOURCE id=')
  // One citation: the note. The invented id was dropped.
  const citation = panel.getByRole('link', { name: 'Open source: Cell notes' })
  await expect(citation).toHaveCount(1)
  await expect(panel).not.toContainText('INVENTED')
  // The answer's Markdown is rendered, not shown as typed.
  await expect(panel.locator('strong', { hasText: 'Key idea' })).toBeVisible()
  await expect(panel.getByRole('listitem').filter({ hasText: 'respiration releases energy' })).toBeVisible()
  await expect(panel).not.toContainText('**')
  await expect(panel.getByRole('log')).not.toHaveAttribute('aria-busy', 'true')

  await citation.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Cell notes' })).toBeVisible()
  if (isPhone(info.project.name)) {
    // The sheet stepped aside for the source.
    await expect(panel).toBeHidden()
    await openChat(page)
  }
  await expect(panel.getByText('About: Cell notes')).toBeVisible()
  await expect(panel.getByText(/Your notes say the mitochondrion/)).toBeVisible()
  expect(errors).toEqual([])
})

test('in review, × and the chat button sit at the two ends of the bar, the chat open or closed', async ({
  page,
}, info) => {
  await seedCourse(page)
  await configureAi(page, LLM)
  await page.goto('./#/review')
  await expect(page.getByTestId('question')).toContainText('Powerhouse of the cell?')
  const close = page.getByRole('button', { name: 'Close' }).first()
  const bar = page.locator('header').filter({ has: close })
  const chat = bar.getByRole('button', { name: 'Ask about this' })
  const edges = async () => {
    const [b, x, c] = await Promise.all([bar.boundingBox(), close.boundingBox(), chat.boundingBox()])
    if (!b || !x || !c) throw new Error('bar not laid out')
    return { left: Math.round(x.x - b.x), right: Math.round(b.x + b.width - (c.x + c.width)) }
  }
  expect(await edges()).toEqual({ left: 0, right: 0 })
  if (!isPhone(info.project.name)) {
    await chat.click()
    await expect(chatPanel(page, info.project.name)).toBeVisible()
    expect(await edges()).toEqual({ left: 0, right: 0 })
  }
})

test('in review, before the reveal the answer never shows; after it, the same answer is readable', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await page.goto('./#/review')
  await expect(page.getByTestId('question')).toContainText('Powerhouse of the cell?')

  await openChat(page)
  const panel = chatPanel(page, info.project.name)
  await expect(panel.getByText('About: this card')).toBeVisible()
  await panel.getByRole('button', { name: 'A hint' }).click()
  await expect(panel.getByText('Parts that would give the answer away are hidden until you reveal it.')).toBeVisible()
  await expect(panel).not.toContainText(/mitochondri/i)
  await expect(panel.getByRole('button', { name: 'Make a card' })).toHaveCount(0)
  // The card's own actions stay as they were, once each, whatever the chat did meanwhile.
  await expect(page.getByRole('button', { name: 'Answer in your own words' })).toHaveCount(1)
  expect(prompts.at(-1)).toContain('Flashcard answer (keep hidden): The mitochondrion')
  expect(prompts.at(-1)).toContain('has NOT seen the flashcard answer')
  expect(prompts.at(-1)).toContain('asks for a hint')

  if (isPhone(info.project.name)) await panel.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /Show answer/ }).click()
  await expect(page.getByTestId('answer')).toContainText('The mitochondrion')
  if (isPhone(info.project.name)) await openChat(page)
  await expect(panel.getByText(/Your notes say the mitochondrion produces ATP/)).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Make a card' })).toBeVisible()
  expect(errors).toEqual([])
})

test('« A hint » is also among the review options: it asks the chat, then gives way to « Why? » once revealed', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await page.goto('./#/review')
  await expect(page.getByTestId('question')).toContainText('Powerhouse of the cell?')

  const options = page.getByRole('main').getByRole('button', { name: 'A hint' })
  await expect(options).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'Why?' })).toHaveCount(0)
  await options.click()
  const panel = chatPanel(page, info.project.name)
  await expect(panel.getByText('Parts that would give the answer away are hidden until you reveal it.')).toBeVisible()
  await expect(panel).not.toContainText(/mitochondri/i)
  expect(prompts.at(-1)).toContain('asks for a hint')

  if (isPhone(info.project.name)) await panel.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /Show answer/ }).click()
  await expect(page.getByRole('main').getByRole('button', { name: 'A hint' })).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('button', { name: 'Why?' })).toBeVisible()
  // After the reveal, the mnemonic sits below the card too, and asks the chat.
  await page.getByRole('main').getByRole('button', { name: 'A mnemonic' }).click()
  if (isPhone(info.project.name)) await expect(panel).toBeVisible()
  await expect.poll(() => prompts.at(-1) ?? '').toContain('asks for a mnemonic')
  expect(errors).toEqual([])
})

async function openNote(page: Page) {
  await openCourse(page)
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page
    .getByRole('main')
    .getByRole('link', { name: /Cell notes/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Cell notes' })).toBeVisible()
}

/** The names of the panel's actions for the screen, in order. */
async function actionNames(panel: Locator): Promise<string[]> {
  const row = panel.getByRole('list', { name: 'Actions for this screen' })
  await expect(row).toBeVisible()
  return row.getByRole('listitem').allInnerTexts()
}

test('the panel offers actions suited to the screen: a card before and after the reveal, a source, a course', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  const phone = isPhone(info.project.name)
  const panel = chatPanel(page, info.project.name)

  await page.goto('./#/review')
  await expect(page.getByTestId('question')).toContainText('Powerhouse of the cell?')
  await openChat(page)
  expect(await actionNames(panel)).toEqual(['Explain the question', 'A hint'])
  if (phone) await panel.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /Show answer/ }).click()
  if (phone) await openChat(page)
  expect(await actionNames(panel)).toEqual(['Why is this the answer?', 'A mnemonic'])
  if (phone) await panel.getByRole('button', { name: 'Close' }).click()

  await openNote(page)
  if (phone) await openChat(page)
  await expect(panel.getByText('About: Cell notes')).toBeVisible()
  expect(await actionNames(panel)).toEqual(['Summarise this source', 'Quiz me'])
  await expect(panel.getByRole('button', { name: 'Summarise this source' })).toBeEnabled()
  if (phone) await panel.getByRole('button', { name: 'Close' }).click()

  await openCourse(page)
  if (phone) await openChat(page)
  await expect(panel.getByText('About: Biology')).toBeVisible()
  expect(await actionNames(panel)).toEqual(['Write a study sheet', 'Quiz me'])
  // Each one is a button that runs on the course, not a link away.
  for (const name of ['Write a study sheet', 'Quiz me']) {
    await expect(panel.getByRole('button', { name, exact: true })).toBeEnabled()
    await expect(panel.getByRole('link', { name, exact: true })).toHaveCount(0)
  }
  expect(errors).toEqual([])
})

test('« Summarise this source » writes a study sheet of the source, cited, on its own screen', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openNote(page)
  await openChat(page)
  await chatPanel(page, info.project.name).getByRole('button', { name: 'Summarise this source' }).click()
  await expect(page).toHaveURL(/#\/fiche\//)
  const sheet = page.getByRole('textbox', { name: 'Study sheet' })
  await expect(sheet.getByRole('heading', { name: 'Energy' })).toBeVisible()
  await expect(sheet.locator('.cm-md-link', { hasText: 'Cell notes' })).toBeVisible()
  const sent = prompts.filter((p) => p.includes('patient tutor'))
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Topic: Cell notes')
  expect(sent[0]).toContain('The mitochondrion produces ATP')
  expect(errors).toEqual([])
})

test('in auto, the chat writes in the language of the source open, not the interface’s', async ({ page }, info) => {
  const errors = watchErrors(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  // A course without a language of its own, and a German note in it.
  await page.goto('./#/')
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill('Klinik')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Klinik' })).toBeVisible()
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: 'Write a note' }).click()
  await page.getByRole('textbox', { name: 'Source' }).click()
  await page.keyboard.type(
    'Natrium und Kalium werden im Serum mit ionenselektiven Elektroden gemessen. Bei einer Hyponatriämie ist die Osmolalität meist erniedrigt, und die Ursache wird über das Volumen gesucht.',
  )
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Klinik' })).toBeVisible()
  // The interface in French.
  await page.goto('./?locale=fr#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Klinik/ })
    .click()
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page
    .getByRole('main')
    .getByRole('link', { name: /Untitled note/ })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Untitled note')
  await page.getByRole('main').getByRole('button', { name: 'Poser une question' }).first().click()
  const panel = isPhone(info.project.name)
    ? page.getByRole('dialog', { name: 'Demander' })
    : page.getByRole('complementary', { name: 'Demander' })
  await panel.getByRole('textbox', { name: 'Votre question' }).fill('Wie misst man Natrium?')
  await panel.getByRole('button', { name: 'Envoyer', exact: true }).click()
  await expect(panel.getByText(/Your notes say the mitochondrion/)).toBeVisible()
  const sent = prompts.filter((p) => p.includes('study tutor')).at(-1) ?? ''
  expect(sent).toContain('Write in German.')
  expect(sent).not.toContain('Write in French.')
  expect(errors).toEqual([])
})

test('« Generate cards » on a course: chosen in « Create cards », they wait in « Suggested cards », the card already there left out', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openCourse(page)
  await page.getByRole('main').getByRole('button', { name: 'Generate cards' }).click()
  const sheet = page.getByRole('dialog', { name: 'Create cards' })
  await expect(sheet.getByLabel('Course or section')).toHaveValue(/./)
  await sheet.getByRole('button', { name: 'Create cards' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Suggested cards' })).toBeVisible()
  const main = page.getByRole('main')
  await expect(main.getByText('Which organelle makes ATP?')).toBeVisible()
  await expect(main.getByText('What do ribosomes build?')).toBeVisible()
  await expect(main.getByText('Powerhouse of the cell?')).toHaveCount(0)
  expect(prompts.some((p) => p.includes('ATP through cellular respiration'))).toBe(true)
  // Nothing is a card yet: the course keeps its one card.
  await openCourse(page)
  await expect(main.getByRole('link', { name: /Which organelle makes ATP\?/ })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('« Quiz me » on a course asks one question at a time on its screen and leaves the review schedule as it was', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  await openCourse(page)
  const meta = await page.getByTestId('place-meta').textContent()
  await page.getByRole('main').getByRole('button', { name: 'Quiz me' }).click()
  await page.getByRole('dialog', { name: 'Quiz me' }).getByRole('button', { name: 'Start the quiz' }).click()
  const main = page.getByRole('main')
  await expect(main.getByText('Practice only: your review schedule is not affected.')).toBeVisible()
  await expect(main.getByText('Question 1 of 2')).toBeVisible()
  await expect(main.getByText('What do ribosomes build?')).toHaveCount(0)
  // The question sits inside its card, not on its top edge.
  const question = main.getByRole('group', { name: /Which organelle makes ATP\?/ })
  const card = await question.boundingBox()
  const legend = await question.locator('legend').boundingBox()
  expect(card && legend && legend.y >= card.y).toBe(true)
  // Corrected, the right choice is ringed (in green, a wrong pick in red); the others keep their hairline.
  const ring = (name: string) =>
    main.getByRole('button', { name, exact: true }).evaluate((b) => getComputedStyle(b).boxShadow)
  const neutral = await ring('The ribosome')
  await main.getByRole('button', { name: 'The mitochondrion' }).click()
  await expect(main.getByText('Correct', { exact: true })).toBeVisible()
  await expect(main.getByText('Respiration runs there.')).toBeVisible()
  expect(await ring('The mitochondrion')).toContain('0px 0px 0px 2px')
  expect(await ring('The ribosome')).toBe(neutral)
  await main.getByRole('button', { name: 'Next question' }).click()
  await expect(main.getByText('Question 2 of 2')).toBeVisible()
  await main.getByRole('button', { name: 'Lipids' }).click()
  await expect(main.getByText('Not quite')).toBeVisible()
  const right = await ring('Proteins')
  const wrong = await ring('Lipids')
  expect(right).toContain('0px 0px 0px 2px')
  expect(wrong).toContain('0px 0px 0px 2px')
  expect(wrong).not.toBe(right)
  await expect(main.getByRole('button', { name: 'Lipids', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(main.getByText('Score: 1 / 2')).toBeVisible()
  await expect(main.getByRole('button', { name: 'Next question' })).toHaveCount(0)
  // The same questions again, from the start.
  await main.getByRole('button', { name: 'Same questions again' }).click()
  await expect(main.getByText('Question 1 of 2')).toBeVisible()

  // Nothing reached the schedule: the course says the same, and its card is still due in review.
  await openCourse(page)
  await expect(page.getByTestId('place-meta')).toHaveText(meta ?? '')
  await page.goto('./#/review')
  await expect(page.getByTestId('question')).toContainText('Powerhouse of the cell?')
  expect(errors).toEqual([])
})

test('without a model there is no chat, no actions and no AI buttons in review', async ({ page }, info) => {
  await seedCourse(page)
  const panel = chatPanel(page, info.project.name)
  await page.goto('./#/review')
  await expect(page.getByTestId('question')).toContainText('Powerhouse of the cell?')
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: 'Explain the question' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Answer in your own words' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Ask about this' })).toHaveCount(0)
  await expect(panel).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'A hint' })).toHaveCount(0)

  await openCourse(page)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: 'Ask about this' })).toHaveCount(0)
  await expect(panel).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Generate cards' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Set up AI' })).toHaveCount(0)
})

test('conversations stay on the device, can be reopened after a reload and deleted', async ({ page }, info) => {
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  await openCourse(page)
  await openChat(page)
  const panel = chatPanel(page, info.project.name)
  await ask(panel, 'Where is ATP made?')
  await expect(panel.getByText(/Your notes say the mitochondrion/)).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
  await openChat(page)
  await panel.getByRole('button', { name: 'Earlier chats' }).click()
  await panel.getByRole('button', { name: 'Open “Where is ATP made?”' }).click()
  await expect(panel.getByText(/Your notes say the mitochondrion/)).toBeVisible()

  await panel.getByRole('button', { name: 'Earlier chats' }).click()
  await panel.getByRole('button', { name: 'Delete “Where is ATP made?”' }).click()
  await expect(panel.getByText('No earlier chats here yet.')).toBeVisible()
})

test('a chat answer becomes a card in the course', async ({ page }, info) => {
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  await openCourse(page)
  await openChat(page)
  const panel = chatPanel(page, info.project.name)
  await ask(panel, 'Where is ATP made?')
  await panel.getByRole('button', { name: 'Make a card' }).click()
  await expect(panel.getByText('Added to Suggested cards.')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Make a card' })).toBeDisabled()
  // Suggested, not added: the course has no such card until it is added from « Suggested cards ».
  await expect(page.getByRole('main').getByRole('link', { name: 'Where is ATP made?' })).toHaveCount(0)
  await panel.getByRole('link', { name: 'Open Suggested cards' }).click()
  if (isPhone(info.project.name)) await panel.getByRole('button', { name: 'Close' }).click()
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'From the chat', exact: true })).toBeVisible()
  await main.getByRole('button', { name: 'Add card 1, From the chat' }).click()
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await openCourse(page)
  await expect(page.getByRole('main').getByRole('link', { name: 'Where is ATP made?' })).toBeVisible()
})

test('⌘J and the palette open the chat once a model is set up; without one they offer nothing', async ({
  page,
}, info) => {
  await seedCourse(page)
  await page.goto('./#/courses')
  await expect(page.getByRole('heading', { level: 1, name: 'Courses' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  const panel = chatPanel(page, info.project.name)
  await page.keyboard.press('ControlOrMeta+j')
  await expect(panel).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('Ask')
  await expect(palette.getByRole('option', { name: 'Ask about this' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()

  await mockProvider(page)
  await configureAi(page, LLM)
  await page.goto('./#/courses')
  await expect(page.getByRole('heading', { level: 1, name: 'Courses' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'Ask about this' }).first()).toBeVisible()
  await page.keyboard.press('ControlOrMeta+j')
  await expect(panel.getByRole('textbox', { name: 'Your question' })).toBeVisible()
  await page.keyboard.press(isPhone(info.project.name) ? 'Escape' : 'ControlOrMeta+j')
  await expect(panel).toBeHidden()

  await page.keyboard.press('ControlOrMeta+k')
  await palette.getByRole('combobox').fill('Ask')
  await palette.getByRole('option', { name: 'Ask about this' }).click()
  await expect(panel.getByRole('textbox', { name: 'Your question' })).toBeVisible()
})

test('the open chat passes axe, and in German at 375 px nothing overflows', async ({ page }, info) => {
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  await openCourse(page)
  await openChat(page)
  const panel = chatPanel(page, info.project.name)
  await ask(panel, 'Where is ATP made?')
  await expect(panel.getByText(/Your notes say the mitochondrion/)).toBeVisible()
  expect(await seriousViolations(page)).toEqual([])

  if (!isPhone(info.project.name)) return
  await page.setViewportSize({ width: 375, height: 740 })
  await page.goto('./?locale=de#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .click()
  await page.getByRole('main').getByRole('button', { name: 'Dazu fragen' }).click()
  const sheet = page.getByRole('dialog', { name: 'Fragen' })
  await expect(sheet.getByText('Zu: Biology')).toBeVisible()
  const overflow = await page.evaluate(() => {
    const d = document.querySelector('dialog[open]')
    return d ? d.scrollWidth - d.clientWidth : -1
  })
  expect(overflow).toBe(0)
})

test('on a 375 px phone in German the chat fills the screen: one header row, only the thread scrolls, nothing overflows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  await page.goto('./?locale=de#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
  await page.getByRole('main').getByRole('button', { name: 'Dazu fragen' }).first().click()
  const chat = page.getByRole('dialog', { name: 'Fragen' })
  await expect(chat.getByText('Zu: Biology')).toBeVisible()

  // The whole screen, not a sheet over part of the page (once it has risen into place).
  await expect
    .poll(async () => {
      const b = await chat.boundingBox()
      return b && [b.x, b.y, b.width, b.height].map(Math.round)
    })
    .toEqual([0, 0, 375, 667])

  // One header row: close, the context, earlier chats, new chat, side by side.
  const close = chat.getByRole('button', { name: 'Chat schließen' })
  const header = [
    close,
    chat.getByText('Zu: Biology'),
    chat.getByRole('button', { name: 'Frühere Chats' }),
    chat.getByRole('button', { name: 'Neuer Chat' }),
  ]
  const boxes: { x: number; y: number; width: number; height: number }[] = []
  for (const part of header) {
    await expect(part).toBeInViewport({ ratio: 1 })
    const b = await part.boundingBox()
    expect(b).not.toBeNull()
    if (b) boxes.push(b)
  }
  const middles = boxes.map((b) => b.y + b.height / 2)
  expect(Math.max(...middles) - Math.min(...middles)).toBeLessThanOrEqual(2)
  boxes.reduce((before, after) => {
    expect(after.x).toBeGreaterThanOrEqual(before.x + before.width)
    return after
  })
  // The screen's actions on one line, scrolled sideways when they do not fit (faded at the edge where more is
  // hidden), right above the composer, within a thumb's reach.
  const row = chat.getByRole('list', { name: 'Aktionen für diesen Bildschirm' })
  const actions = row.getByRole('listitem')
  const tops = await actions.evaluateAll((items) => items.map((i) => Math.round(i.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(1)
  if (await row.evaluate((r) => r.scrollWidth > r.clientWidth)) await expect(row).toHaveAttribute('data-more', 'end')
  const rowBox = await row.boundingBox()
  const logBox = await chat.getByRole('log').boundingBox()
  const composerBox = await chat.getByRole('textbox', { name: 'Deine Frage' }).boundingBox()
  if (!rowBox || !logBox || !composerBox) throw new Error('missing box')
  expect(rowBox.y).toBeGreaterThanOrEqual(logBox.y + logBox.height - 1)
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(composerBox.y + 1)

  const box = chat.getByRole('textbox', { name: 'Deine Frage' })
  for (const n of [1, 2, 3, 4]) {
    await box.fill(`Frage ${n}: Was macht das Mitochondrium in der Zelle?`)
    await chat.getByRole('button', { name: 'Senden', exact: true }).click()
    await expect(chat.getByText(`Frage ${n}:`)).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Stopp' })).toHaveCount(0)
  }
  // The last answer and the composer are on screen; the thread scrolls, the screen does not.
  await expect(chat.getByRole('button', { name: 'Kopieren' }).last()).toBeInViewport()
  await expect(box).toBeInViewport({ ratio: 1 })
  await expect(chat.getByRole('button', { name: 'Senden', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(close).toBeInViewport({ ratio: 1 })
  const scroll = await chat.evaluate((d) => {
    const log = d.querySelector('[role="log"]')
    return {
      dialog: d.scrollHeight - d.clientHeight,
      thread: log ? log.scrollHeight - log.clientHeight : 0,
      wide: d.scrollWidth - d.clientWidth,
      page: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
  expect(scroll.dialog).toBe(0)
  expect(scroll.thread).toBeGreaterThan(0)
  expect(scroll.wide).toBe(0)
  expect(scroll.page).toBeLessThanOrEqual(0)
})

test('a long conversation keeps its latest answer in view above the composer, which grows with the question', async ({
  page,
}, info) => {
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  await openCourse(page)
  await openChat(page)
  const panel = chatPanel(page, info.project.name)
  const box = panel.getByRole('textbox', { name: 'Your question' })
  for (const n of [1, 2, 3, 4]) {
    await ask(panel, `Question ${n}: what does the mitochondrion do in the cell?`)
    await expect(panel.getByText(`Question ${n}:`)).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  }
  // The thread scrolls inside the panel: the last answer and its actions show, the composer stays put.
  await expect(panel.getByRole('button', { name: 'Copy' }).last()).toBeInViewport()
  await expect(box).toBeInViewport()
  // A dropped citation leaves no gap before the full stop that followed it.
  await expect(panel).not.toContainText('respiration .')

  const oneLine = (await box.boundingBox())?.height ?? 0
  await box.fill('line one\nline two\nline three')
  await expect.poll(async () => (await box.boundingBox())?.height ?? 0).toBeGreaterThan(oneLine)
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(async () => (await box.boundingBox())?.height ?? 0).toBeLessThanOrEqual(oneLine + 1)
})

test('a chat action runs once: the model removed, then set up again, sends nothing more', async ({ page }, info) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await page.goto('./#/review')
  await expect(page.getByTestId('question')).toContainText('Powerhouse of the cell?')
  await page.getByRole('button', { name: 'Explain the question' }).click()
  const panel = chatPanel(page, info.project.name)
  await expect.poll(() => prompts.length).toBeGreaterThan(0)
  await page.waitForLoadState('networkidle')
  const asked = prompts.length
  const generated = () => prompts.length
  await panel.getByRole('button', { name: 'Close chat' }).click()
  await expect(panel).toBeHidden()

  // In the same page: the key removed, the AI is gone from the course.
  const hop = (hash: string) =>
    page.evaluate((h) => {
      location.hash = h
    }, hash)
  await hop('/settings/ai')
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible()
  await page.getByLabel('API key').fill('')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await hop('/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'Ask about this' })).toHaveCount(0)

  // The key back: the chat comes back, and « Explain the question » is not asked again on its own.
  await hop('/settings/ai')
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible()
  await page.getByLabel('API key').fill('sk-test-123')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'Ask about this' }).first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(500)
  expect(generated()).toBe(asked)
  await expect(panel).toBeHidden()
  // Opened by hand, nothing is sent on its own.
  await page.getByRole('main').getByRole('button', { name: 'Ask about this' }).first().click()
  await expect(panel).toBeVisible()
  await page.waitForTimeout(300)
  expect(generated()).toBe(asked)
  expect(errors).toEqual([])
})

test('with the keyboard up the chat stays above it: over the page the thread takes the room, docked the panel ends at the keyboard', async ({
  page,
}, info) => {
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  await openCourse(page)
  await openChat(page)
  const panel = chatPanel(page, info.project.name)
  await ask(panel, 'Where is ATP made?')
  await expect(panel.getByText(/Your notes say the mitochondrion/)).toBeVisible()
  const actions = panel.getByRole('list', { name: 'Actions for this screen' })
  await expect(actions).toBeVisible()

  // The keyboard as iOS reports it (useKeyboardInset): 300 px of the screen's bottom.
  const KEYBOARD = 300
  await page.evaluate((inset) => {
    document.documentElement.style.setProperty('--kb-inset', `${inset}px`)
    document.documentElement.dataset.keyboard = 'open'
  }, KEYBOARD)
  await panel.getByRole('textbox', { name: 'Your question' }).focus()
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')
  const composer = await panel.getByRole('textbox', { name: 'Your question' }).boundingBox()
  if (!composer) throw new Error('missing box')
  // Whatever the layout, the composer stays above the keyboard.
  expect(composer.y + composer.height).toBeLessThanOrEqual(viewport.height - KEYBOARD + 1)
  if (await page.getByRole('dialog', { name: 'Ask' }).isVisible()) {
    // Over the page, the actions step aside: the thread keeps the room.
    await expect(actions).toBeHidden()
    const thread = await panel.getByRole('log').evaluate((l) => l.clientHeight)
    expect(thread).toBeGreaterThanOrEqual(180)
  } else {
    // Docked beside the page, nothing is covered: the actions stay.
    await expect(actions).toBeVisible()
  }
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--kb-inset', '0px')
    delete document.documentElement.dataset.keyboard
  })
  await expect(actions).toBeVisible()
})

test('on a panel wider than a phone, every action shows whole: none is cut at the edge', async ({ page }, info) => {
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  await page.goto('./?locale=de#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .click()
  await page.getByRole('main').getByRole('button', { name: 'Dazu fragen' }).first().click()
  const panel = isPhone(info.project.name)
    ? page.getByRole('dialog', { name: 'Fragen' })
    : page.getByRole('complementary', { name: 'Fragen' })
  const row = panel.getByRole('list', { name: 'Aktionen für diesen Bildschirm' })
  await expect(row).toBeVisible()
  const width = await panel.evaluate((p) => p.getBoundingClientRect().width)
  if (width < 600) {
    // A phone: one line that scrolls, said by a fade where more is hidden.
    if (await row.evaluate((r) => r.scrollWidth > r.clientWidth)) await expect(row).toHaveAttribute('data-more', 'end')
    return
  }
  const box = await panel.boundingBox()
  if (!box) throw new Error('missing box')
  for (const chip of await row.getByRole('button').all()) {
    await expect(chip).toBeInViewport({ ratio: 1 })
    const b = await chip.boundingBox()
    expect(b && b.x + b.width <= box.x + box.width + 0.5).toBe(true)
  }
  expect(await row.evaluate((r) => r.scrollWidth - r.clientWidth)).toBeLessThanOrEqual(0)
})
