import { expect, type Page, type Route, test } from '@playwright/test'
import { configureAi } from './support/ai'
import { createHarness } from './support/harness.ts'

// « Explain the question » and « Explain a concept » against an intercepted provider: before the reveal
// nothing shown gives the answer away (redacted fields, citations as bare links, « Show anyway »);
// after it everything shows; a selected term in a source is explained, explored and turned into a card.
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

/** A concept explained; for "cell" the explanation and a related concept name the card's answer. */
function conceptExplanation(prompt: string) {
  const note = noteId(prompt)
  const term = /<<<TERM>>>\n([^\n]+)/.exec(prompt)?.[1] ?? 'missing-term'
  if (term === 'cell') {
    return {
      definition: 'The smallest unit of life.',
      explanation: 'Each cell gets its energy from the mitochondrion.',
      example: 'A red blood cell.',
      relatedConcepts: ['Organelle', 'Mitochondrion'],
      citations: [{ sourceId: note }],
      suggestedCard: { front: 'What is a cell?', back: 'The smallest unit of life' },
    }
  }
  return {
    definition: `${term}: what the course calls it.`,
    explanation: `How ${term} fits in the course.`,
    example: `An example of ${term}.`,
    relatedConcepts: ['Cellular respiration'],
    citations: [{ sourceId: note }],
    suggestedCard: { front: `What is ${term}?`, back: `${term}, in short` },
  }
}

async function mockProvider(page: Page): Promise<string[]> {
  const prompts: string[] = []
  await page.route(`${LLM}/**`, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const text = textOf(req.postDataJSON() as Body)
    prompts.push(text)
    let out: unknown = 'OK'
    if (text.includes('asks what the question means')) out = questionExplanation(text)
    else if (text.includes('selected a term in their course material')) out = conceptExplanation(text)
    const content = typeof out === 'string' ? out : JSON.stringify(out)
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

test('before the reveal the question is explained without its answer; after it, everything shows', async ({ page }) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openReview(page)

  await page.getByRole('button', { name: 'Explain the question' }).click()
  const sheet = page.getByRole('dialog', { name: 'Explain the question' })
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
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(sheet).toBeHidden()
  await page.getByRole('button', { name: /Show answer/ }).click()
  await expect(page.getByTestId('answer')).toContainText('The mitochondrion')
  await page.getByRole('button', { name: 'Explain the question' }).click()
  await expect(sheet.getByText('The mitochondrion is where cellular respiration happens in your notes.')).toBeVisible()
  await expect(sheet.getByText('Hidden: it gives the answer away.')).toHaveCount(0)
  await expect(sheet.getByRole('blockquote')).toContainText(PASSAGE)
  expect(prompts.length).toBe(asked)
  expect(errors).toEqual([])
})

test('a term selected in the question is explained without the answer, explored, and made a card', async ({ page }) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openReview(page)

  await expect(page.getByRole('button', { name: 'Explain a concept' })).toBeVisible()
  await selectText(page, '[data-testid="question"]', 'cell')
  await page.getByRole('button', { name: 'Explain “cell”' }).click()
  const sheet = page.getByRole('dialog', { name: 'Explain “cell”' })
  await expect(sheet.getByText('The smallest unit of life.')).toBeVisible()
  // Explained in the question alone: the answer is not handed over as context.
  expect(prompts.at(-1)).toMatch(/<<<CONTEXT>>>\nPowerhouse of the cell\?\n<<<END CONTEXT>>>/)

  // The explanation and a related concept named the answer: redacted until shown anyway.
  await expect(sheet.getByText('Each cell gets its energy from the […].')).toBeVisible()
  await expect(sheet).not.toContainText(/mitochondri/i)
  await expect(sheet).not.toContainText(PASSAGE)
  await expect(sheet.getByRole('button', { name: 'Show anyway' })).toHaveCount(2)
  await sheet.getByRole('button', { name: 'Show anyway' }).first().click()
  await expect(sheet.getByText('Each cell gets its energy from the mitochondrion.')).toBeVisible()
  await sheet.getByRole('button', { name: 'Show anyway' }).click()
  await expect(sheet.getByRole('button', { name: 'Explain “Mitochondrion”' })).toBeVisible()

  // A related concept is explained in turn.
  await sheet.getByRole('button', { name: 'Explain “Organelle”' }).click()
  const next = page.getByRole('dialog', { name: 'Explain “Organelle”' })
  await expect(next.getByText('Organelle: what the course calls it.')).toBeVisible()
  expect(prompts.at(-1)).toContain('<<<TERM>>>\nOrganelle\n<<<END TERM>>>')

  // A typed concept, at another level.
  await next.getByLabel('Concept', { exact: true }).fill('Ribosome')
  await next.getByRole('radio', { name: 'In depth' }).check({ force: true })
  await next.getByRole('button', { name: 'Explain', exact: true }).click()
  const typed = page.getByRole('dialog', { name: 'Explain “Ribosome”' })
  await expect(typed.getByText('Ribosome: what the course calls it.')).toBeVisible()
  expect(prompts.at(-1)).toContain('Explain it rigorously')

  await typed.getByRole('button', { name: 'Create a card on this concept' }).click()
  await expect(typed.getByText('Card added to Biology.')).toBeVisible()
  await expect(typed.getByRole('button', { name: 'Create a card on this concept' })).toBeDisabled()
  expect(errors).toEqual([])
})

test('a term selected in a source opens its explanation, cited in full, and becomes a card', async ({ page }) => {
  const errors = watchErrors(page)
  await seedCourse(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openNote(page)

  await expect(page.getByRole('button', { name: /^Explain “/ })).toHaveCount(0)
  await selectText(page, '.cm-content', 'ATP')
  await page.getByRole('button', { name: 'Explain “ATP”' }).click()
  const sheet = page.getByRole('dialog', { name: 'Explain “ATP”' })
  await expect(sheet.getByText('ATP: what the course calls it.')).toBeVisible()
  // The line it was selected in goes along as context, grounded in the course's sources.
  expect(prompts.at(-1)).toContain('<<<TERM>>>\nATP\n<<<END TERM>>>')
  expect(prompts.at(-1)).toMatch(/<<<CONTEXT>>>\nThe mitochondrion produces ATP through cellular respiration\./)
  // Outside a review there is no answer to hide: the cited passage shows with its link.
  await expect(sheet.getByRole('link', { name: 'Open source: Cell notes' })).toBeVisible()
  await expect(sheet.getByRole('blockquote')).toContainText(PASSAGE)
  await expect(sheet.getByRole('button', { name: 'Show anyway' })).toHaveCount(0)

  await sheet.getByRole('button', { name: 'Explain “Cellular respiration”' }).click()
  const next = page.getByRole('dialog', { name: 'Explain “Cellular respiration”' })
  await expect(next.getByText('Cellular respiration: what the course calls it.')).toBeVisible()
  await next.getByRole('button', { name: 'Create a card on this concept' }).click()
  await expect(next.getByText('Card added to Biology.')).toBeVisible()
  await next.getByRole('button', { name: 'Close' }).click()

  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .click()
  await expect(page.getByRole('main').getByRole('link', { name: 'What is Cellular respiration?' })).toBeVisible()
  expect(errors).toEqual([])
})

test('without a model review offers no explanation and a source links to the AI settings', async ({ page }) => {
  await seedCourse(page)
  await openReview(page)
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Explain the question' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Explain a concept' })).toHaveCount(0)

  await openNote(page)
  await selectText(page, '.cm-content', 'ATP')
  await page.getByRole('link', { name: 'Set up AI to explain “ATP”' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible()
})

test('offline the explanations are disabled, saying why', async ({ page, context }) => {
  await seedCourse(page)
  await mockProvider(page)
  await configureAi(page, LLM)
  await openReview(page)
  await expect(page.getByRole('button', { name: 'Explain the question' })).toBeEnabled()
  await context.setOffline(true)
  await expect(page.getByRole('button', { name: 'Explain the question' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Explain a concept' })).toBeDisabled()
  await expect(page.getByText('You’re offline. Explanations need a connection.')).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByRole('button', { name: 'Explain the question' })).toBeEnabled()
})
