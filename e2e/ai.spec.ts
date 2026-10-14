import { join } from 'node:path'
import { expect, type Page, type Route, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

const LLM = 'https://llm.mock.test/v1'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

const FIXTURES = join(import.meta.dirname, 'fixtures')

/** Cites the first source block without a page (the note) and page 2 of the paged one (the PDF). */
function understanding(prompt: string) {
  const note = /<<<SOURCE id="([^"]+)">>>/.exec(prompt)?.[1] ?? 'missing-note'
  const pdf = /<<<SOURCE id="([^"]+)" page="2">>>/.exec(prompt)?.[1] ?? 'missing-pdf'
  return {
    title: 'Photosynthesis',
    summary: 'Plants turn light into chemical energy.',
    points: [
      {
        heading: 'Light reactions',
        explanation: 'Chlorophyll captures light in the thylakoids.',
        sourceRef: { sourceId: note },
      },
      {
        heading: 'Calvin cycle',
        explanation: 'CO2 is fixed into sugar in the stroma.',
        sourceRef: { sourceId: pdf, page: 2 },
      },
    ],
  }
}
const REVIEW = {
  score: 72,
  strengths: ['You named chlorophyll.'],
  gaps: ['The Calvin cycle is missing.'],
  misconceptions: [],
  feedback: 'Good start.',
}
const CARDS = {
  cards: [
    { kind: 'basic', front: 'Where do the light reactions happen?', back: 'In the thylakoids' },
    { kind: 'basic', front: 'Where do the light reactions happen ?', back: 'Thylakoid membranes' },
    { kind: 'cloze', front: 'The Calvin cycle runs in the {{c1::stroma}}.', back: '' },
  ],
}
const QUIZ = {
  questions: [
    { question: 'What captures light?', choices: ['Chlorophyll', 'Starch'], answerIndex: 0, explanation: 'Pigment.' },
    { question: 'Where is CO2 fixed?', choices: ['Thylakoid', 'Stroma'], answerIndex: 1, explanation: 'Stroma.' },
  ],
}

const usage = { prompt_tokens: 120_000, completion_tokens: 40_000 }

function completion(content: string) {
  return {
    id: 'cmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'claude-haiku-5-5',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  }
}

/** Streams `content` in small deltas, as an OpenAI-compatible server would. */
function sse(content: string): string {
  const parts: string[] = []
  for (let i = 0; i < content.length; i += 24) parts.push(content.slice(i, i + 24))
  const base = { id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, model: 'claude-haiku-5-5' }
  const events: Record<string, unknown>[] = parts.map((p, i) => ({
    ...base,
    choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: p } : { content: p }, finish_reason: null }],
  }))
  events.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  events.push({ ...base, choices: [], usage })
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`
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

async function mockProvider(page: Page): Promise<string[]> {
  const prompts: string[] = []
  await page.route(`${LLM}/**`, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    expect(req.headers().authorization).toBe('Bearer sk-test-123')
    const body = req.postDataJSON() as Body
    const text = textOf(body)
    prompts.push(text)
    let out: unknown = { ok: true }
    if (text.includes('patient tutor')) out = understanding(text)
    else if (text.includes('in their own words')) out = REVIEW
    else if (text.includes('flashcards')) out = CARDS
    else if (text.includes('multiple-choice')) out = QUIZ
    const json = typeof out === 'object' && out !== null && 'ok' in out ? 'OK' : JSON.stringify(out)
    if (body.stream) {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sse(json) })
    }
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', json: completion(json) })
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
  return prompts
}

/** Picks a browser-callable model, stores a key and points it at the mocked provider. */
async function configure(page: Page) {
  await page.goto('./#/settings/ai')
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search models' }).fill('302 haiku 5.5')
  const row = page.getByRole('button', { name: /^Claude Haiku 5\.5\s*302\.AI/ }).first()
  await expect(row.getByText('Works in browser')).toBeVisible()
  await row.click()
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await page.getByLabel('API key').fill('sk-test-123')
  await page.getByLabel('Base URL').fill(LLM)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved on this device.')).toBeVisible()
}

test('AI settings: catalog filters, key in the device vault, test, cost and refresh', async ({ page }) => {
  await mockProvider(page)
  await configure(page)

  // Filters: unchecking "Works in the browser" shows providers that need a proxy too.
  const count = page.getByText(/^\d+ models?$/)
  const before = Number((await count.textContent())?.split(' ')[0])
  await page.getByRole('searchbox', { name: 'Search models' }).fill('')
  await page.getByLabel('Structured output').check()
  await expect(count).not.toHaveText(`${before} models`)

  await expect(page.getByTestId('ai-month-cost')).toHaveText('$0.00')
  await page.getByRole('button', { name: 'Test' }).click()
  await expect(page.getByText('Connection works.')).toBeVisible()
  // 120k input × $0.10/M + 40k output × $0.50/M = $0.032.
  await expect(page.getByTestId('ai-month-cost')).toHaveText('$0.03')

  // The key lives in the device vault, never in the synced doc.
  const stored = await page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('cursus-v1')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const get = open.result.transaction('secrets').objectStore('secrets').get('cursus-ai-key-302ai')
          get.onsuccess = () => resolve(get.result)
          get.onerror = () => reject(get.error)
        }
      }),
  )
  expect(stored).toBe('sk-test-123')

  await page.getByRole('radio', { name: 'Français' }).check({ force: true })
  await expect(page.getByText('Output language saved on this device.')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('API key')).toHaveValue('sk-test-123')
  await expect(page.getByLabel('Base URL')).toHaveValue(LLM)
  await expect(page.getByRole('radio', { name: 'Français' })).toBeChecked()

  await page.getByRole('button', { name: 'Refresh catalog' }).click()
  await expect(page.getByText('Catalog updated.')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Claude Haiku 5\.5\s*302\.AI/ })).toBeVisible()
})

test('AI screens ask for a model until one is set up', async ({ page }) => {
  await page.goto('./#/understand')
  await expect(page.getByText('Add an API key in Settings to use the AI.')).toBeVisible()
  await page.getByRole('link', { name: 'Open AI settings' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible()
})

test('Understand streams a cited explanation, then checks an explanation back', async ({ page }) => {
  const prompts = await mockProvider(page)
  await configure(page)

  // Ground the explanation in the course's own sources: a written note and an imported PDF.
  await page.goto('./#/')
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill('Botany')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Botany' })).toBeVisible()
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByRole('button', { name: 'Write a note' }).click()
  await page.getByRole('textbox', { name: 'Source' }).click()
  await page.keyboard.type('Chlorophyll captures light. The Calvin cycle fixes CO2.')
  await page.getByRole('link', { name: 'Back' }).click()
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByLabel('Import PDF').setInputFiles(join(FIXTURES, 'sample.pdf'))
  await expect(page.getByRole('heading', { level: 1, name: 'sample' })).toBeVisible()

  await page.goto('./#/understand')
  await expect(page.getByRole('checkbox', { name: 'Untitled note' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'sample' })).toBeChecked()
  await page.getByLabel('What do you want to understand?').fill('photosynthesis')
  await page.getByRole('radio', { name: 'In depth' }).check({ force: true })
  await expect(page.getByText(/Estimated cost: \$/)).toBeVisible()
  await page.getByRole('button', { name: 'Explain', exact: true }).click()

  const fiche = page.getByRole('article', { name: 'Explanation' })
  await expect(fiche.getByRole('heading', { name: 'Photosynthesis' })).toBeVisible()
  await expect(fiche.getByRole('heading', { name: 'Calvin cycle' })).toBeVisible()
  await expect(fiche.getByRole('link', { name: 'Open source: Untitled note' })).toBeVisible()
  await expect(fiche.getByRole('link', { name: 'Open source: sample, p. 2' })).toBeVisible()
  expect(prompts.at(-1)).toContain('Chlorophyll captures light')
  expect(prompts.at(-1)).toContain('Second page mitochondria')
  expect(prompts.at(-1)).toContain('cover edge cases')

  await page.getByLabel('Your explanation').fill('Plants use chlorophyll to catch light.')
  await page.getByRole('button', { name: 'Check my explanation' }).click()
  await expect(page.getByText('72 / 100')).toBeVisible()
  await expect(page.getByText('The Calvin cycle is missing.')).toBeVisible()

  // A page citation opens the PDF at that page.
  await fiche.getByRole('link', { name: 'Open source: sample, p. 2' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'sample' })).toBeVisible()
  await expect(page.getByText('Cited on page 2.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open PDF' })).toHaveAttribute('href', /^blob:.+#page=2$/)
  // The page belongs to that citation only: opening the source again starts from the top.
  await page.getByRole('link', { name: 'Back' }).click()
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page
    .getByRole('main')
    .getByRole('link', { name: /sample/ })
    .click()
  await expect(page.getByRole('link', { name: 'Open PDF' })).toHaveAttribute('href', /^blob:[^#]+$/)
})

test('Generate de-duplicates drafts, lets them be edited, then saves them as cards', async ({ page }) => {
  await mockProvider(page)
  await configure(page)
  await page.goto('./#/')
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill('Biology')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()

  await page.goto('./#/generate')
  await expect(page.getByRole('combobox', { name: 'Course', exact: true })).toHaveValue(/.+/)
  await page.getByLabel('Paste text (optional)').fill('Light reactions happen in the thylakoids.')
  await page.getByRole('button', { name: 'Draft cards' }).click()
  await expect(page.getByText('2 cards generated')).toBeVisible()
  await expect(page.getByText('1 duplicate removed')).toBeVisible()

  await page.getByLabel('Front of card 1').fill('Where do light reactions take place?')
  await page.getByRole('button', { name: 'Save 2 cards' }).click()
  await expect(page.getByText('2 cards saved.')).toBeVisible()
  await page.getByRole('link', { name: 'Open course' }).click()
  await expect(page.getByText('Where do light reactions take place?')).toBeVisible()
})

test('Quiz scores answers without touching the review schedule', async ({ page }) => {
  await mockProvider(page)
  await configure(page)
  await page.goto('./#/quiz')
  await expect(page.getByText('Practice only: your review schedule is not affected.')).toBeVisible()
  await page.getByLabel('Paste text (optional)').fill('Chlorophyll captures light; CO2 is fixed in the stroma.')
  await page.getByRole('button', { name: 'Start quiz' }).click()
  await page.getByRole('radio', { name: 'Chlorophyll' }).check()
  await page.getByRole('radio', { name: 'Thylakoid' }).check()
  await page.getByRole('button', { name: 'Check answers' }).click()
  await expect(page.getByText('Score: 1 / 2')).toBeVisible()
  await expect(page.getByText('Not quite')).toBeVisible()
})
