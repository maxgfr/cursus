import { expect, type Page, type Route, test } from '@playwright/test'
import { chatPanel, configureAi } from './support/ai'
import { createHarness } from './support/harness.ts'
import { isPhone, seriousViolations, watchErrors } from './support/page.ts'

// « Quiz me » is set up first: where (a course or one of its sections), how many questions, how hard, and the weak
// points first; then it runs in the chat on that place's sources only.

test.use({ serviceWorkers: 'block' })

const LLM = 'https://llm.mock.test/v1'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}
const DAY = 86_400_000

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

interface Body {
  messages: { role: string; content: string | { type: string; text?: string }[] }[]
}
const textOf = (body: Body) =>
  body.messages
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((c) => c.text ?? '').join('\n')))
    .join('\n')

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

/** An OpenAI-compatible provider: one question for a quiz, « OK » to anything else; the quiz prompts kept. */
async function mockProvider(page: Page): Promise<string[]> {
  const quizzes: string[] = []
  await page.route(`${LLM}/**`, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const text = textOf(req.postDataJSON() as Body)
    let content = 'OK'
    if (text.includes('Write multiple-choice questions')) {
      quizzes.push(text)
      content = JSON.stringify({
        questions: [
          { question: 'What does the heart pump?', choices: ['Blood', 'Air'], answerIndex: 0, explanation: 'Blood.' },
        ],
      })
    }
    if ((req.postDataJSON() as { stream?: boolean }).stream) {
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'text/event-stream' },
        body: sse(content),
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
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1200, completion_tokens: 400 },
      },
    })
  })
  return quizzes
}

async function seed(page: Page) {
  const now = Date.now()
  await harness.seed(page, {
    courses: [
      { title: 'Anatomy', notes: [{ title: 'Bones', body: 'Bones hold the body up. The femur is the longest bone.' }] },
      {
        title: 'Physiology',
        notes: [{ title: 'Overview', body: 'Physiology studies how the body works.' }],
        sections: [
          {
            name: 'Cardio',
            notes: [{ title: 'Heart', body: 'The heart pumps blood through two circuits.' }],
            cards: [
              {
                front: 'What does the heart pump?',
                back: 'Blood',
                reviews: [
                  { rating: 4, at: now - 40 * DAY },
                  { rating: 1, at: now - 2 * DAY },
                ],
              },
              { front: 'How many circuits?', back: 'Two', reviews: [{ rating: 4, at: now - DAY }] },
            ],
          },
        ],
      },
    ],
  })
}

test('« Quiz me » from Practice: a section, 10 hard questions on its sources, its weak points first', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await seed(page)
  const quizzes = await mockProvider(page)
  await configureAi(page, LLM)
  await page.goto('./#/sessions')
  await page
    .getByRole('main')
    .getByRole('button', { name: /^Quiz me/ })
    .click()
  const sheet = page.getByRole('dialog', { name: 'Quiz me' })
  await expect(sheet).toBeVisible()
  const node = sheet.getByLabel('Course or section')
  await node.selectOption({ label: 'Physiology › Cardio · 1 source' })
  // The weak points of the section are on by default: one of its cards was forgotten two days ago.
  const focus = sheet.getByRole('checkbox', { name: 'Focus on my weak points' })
  await expect(focus).toBeChecked()
  await expect(sheet.getByText('The card you keep getting wrong here is asked about first.')).toBeVisible()
  await sheet.getByRole('radio', { name: '10', exact: true }).check({ force: true })
  await sheet.getByRole('radio', { name: 'Hard' }).check({ force: true })
  expect(await seriousViolations(page, '[role="dialog"], dialog[open]')).toEqual([])
  await sheet.getByRole('button', { name: 'Start the quiz' }).click()

  // The quiz runs in the chat beside the section, on its own sources only.
  await expect(page.getByRole('heading', { level: 1, name: 'Cardio' })).toBeVisible()
  const chat = chatPanel(page, info.project.name)
  await expect(chat.getByText('What does the heart pump?').first()).toBeVisible()
  expect(quizzes).toHaveLength(1)
  const sent = quizzes[0] ?? ''
  expect(sent).toContain('Number of questions: 10')
  expect(sent).toContain('Difficulty: hard')
  expect(sent).toContain('Weak points to test first')
  expect(sent).toContain('- What does the heart pump?')
  expect(sent).not.toContain('- How many circuits?')
  expect(sent).toContain('The heart pumps blood through two circuits.')
  expect(sent).not.toContain('Bones hold the body up')
  expect(sent).not.toContain('Physiology studies how the body works')
  // « Run again » keeps the options: the answer's drawer shows them.
  await chat
    .getByText(/^10 questions/)
    .first()
    .click()
  await expect(chat.getByRole('radio', { name: 'Hard' })).toBeChecked()
  await expect(chat.getByRole('checkbox', { name: 'Focus on my weak points' })).toBeChecked()
  expect(errors).toEqual([])
})

test('on a course, « Quiz me » opens set up on it; the place quizzed last comes back next time', async ({
  page,
}, info) => {
  await seed(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Anatomy/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Anatomy' })).toBeVisible()
  await page.getByRole('main').getByRole('button', { name: 'Quiz me' }).click()
  const sheet = page.getByRole('dialog', { name: 'Quiz me' })
  await expect(sheet.getByLabel('Course or section')).toHaveValue(/^c:/)
  await expect(sheet.getByLabel('Course or section').locator('option:checked')).toHaveText('Anatomy · 1 source')
  // A course without cards has no weak point: nothing to focus on.
  await expect(sheet.getByRole('checkbox', { name: 'Focus on my weak points' })).toBeDisabled()
  await sheet.getByRole('button', { name: 'Start the quiz' }).click()
  const chat = chatPanel(page, info.project.name)
  await expect(chat.getByText('What does the heart pump?').first()).toBeVisible()
  // On a phone the chat covers the screen: closed, to see Practice.
  if (isPhone(info.project.name)) await chat.getByRole('button', { name: 'Close chat' }).click()
  await page.goto('./#/sessions')
  await page
    .getByRole('main')
    .getByRole('button', { name: /^Quiz me/ })
    .click()
  await expect(
    page.getByRole('dialog', { name: 'Quiz me' }).getByLabel('Course or section').locator('option:checked'),
  ).toHaveText('Anatomy · 1 source')
})

test('without a model, « Quiz me » is nowhere', async ({ page }) => {
  await seed(page)
  await page.goto('./#/sessions')
  await expect(page.getByRole('heading', { level: 1, name: 'Practice' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Quiz me/ })).toHaveCount(0)
  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Physiology/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Physiology' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Quiz me' })).toHaveCount(0)
})
