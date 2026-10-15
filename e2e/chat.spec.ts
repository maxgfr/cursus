import { expect, type Locator, type Page, type Route, test } from '@playwright/test'
import { configureAi } from './support/ai'
import { createHarness } from './support/harness.ts'
import { isPhone, seriousViolations } from './support/page.ts'

// The chat beside every screen, against an intercepted provider that streams its answers: it knows what is on
// screen (a course, a source, a card), cites the course's sources, never gives a hidden answer away, keeps its
// conversations on the device, and is a sheet on phones.
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

/** The chat: docked beside the page from 1000px, a sheet on phones. */
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
  await expect(panel.getByRole('button', { name: 'Quiz me on this course' })).toBeVisible()

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
  await panel.getByRole('button', { name: 'Help me think about this card, without the answer' }).click()
  await expect(panel.getByText('Parts that would give the answer away are hidden until you reveal it.')).toBeVisible()
  await expect(panel).not.toContainText(/mitochondri/i)
  await expect(panel.getByRole('button', { name: 'Make a card' })).toHaveCount(0)
  expect(prompts.at(-1)).toContain('Flashcard answer (keep hidden): The mitochondrion')
  expect(prompts.at(-1)).toContain('has NOT seen the flashcard answer')

  if (isPhone(info.project.name)) await panel.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /Show answer/ }).click()
  await expect(page.getByTestId('answer')).toContainText('The mitochondrion')
  if (isPhone(info.project.name)) await openChat(page)
  await expect(panel.getByText(/Your notes say the mitochondrion produces ATP/)).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Make a card' })).toBeVisible()
  expect(errors).toEqual([])
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
  await expect(panel.getByText('Card added to Biology.')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Make a card' })).toBeDisabled()
  if (isPhone(info.project.name)) await panel.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('main').getByRole('link', { name: 'Where is ATP made?' })).toBeVisible()
})

test('⌘J and the palette open the chat; without a model it points to the AI settings', async ({ page }, info) => {
  await seedCourse(page)
  await page.goto('./#/courses')
  await expect(page.getByRole('heading', { level: 1, name: 'Courses' })).toBeVisible()
  const panel = chatPanel(page, info.project.name)
  await page.keyboard.press('ControlOrMeta+j')
  await expect(panel.getByText('Set up AI to ask questions')).toBeVisible()
  await expect(panel.getByRole('link', { name: 'Set up AI' })).toHaveAttribute('href', /#\/settings\/ai/)
  await page.keyboard.press(isPhone(info.project.name) ? 'Escape' : 'ControlOrMeta+j')
  await expect(panel).toBeHidden()

  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('Ask')
  await palette.getByRole('option', { name: 'Ask about this' }).click()
  await expect(panel.getByText('Set up AI to ask questions')).toBeVisible()
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
