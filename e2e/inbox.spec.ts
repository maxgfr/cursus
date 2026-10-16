import { join } from 'node:path'
import { expect, type Page, type Route, test } from '@playwright/test'
import { chatPanel, configureAi } from './support/ai'
import { createHarness } from './support/harness.ts'
import { createCourse, isPhone, seriousViolations, watchErrors } from './support/page.ts'

// Cards are suggested only when the student asks; « Suggested cards » adds, edits or rejects each one at once, with a
// moment to undo.

test.use({ serviceWorkers: 'block' })

const LLM = 'https://llm.mock.test/v1'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}
const PDF = join(import.meta.dirname, '..', 'tests', 'fixtures', 'content', 'slides.pdf')
const PHOTO = join(import.meta.dirname, 'fixtures', 'large.png')

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

/** An OpenAI-compatible provider: two cards per unit for the suggestions, « OK » to anything else. */
async function mockProvider(page: Page): Promise<string[]> {
  const asked: string[] = []
  await page.route(`${LLM}/**`, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const text = textOf(req.postDataJSON() as Body)
    let content = 'OK'
    if (text.includes('spaced-repetition questions on course material')) {
      asked.push(text)
      const questions: Record<string, unknown>[] = []
      for (const m of text.matchAll(/<<<UNIT n="(\d+)"[^>]*>>>\n([\s\S]*?)\n<<<END UNIT>>>/g)) {
        const unit = Number(m[1])
        const title = /Title: (.*)/.exec(m[2] ?? '')?.[1]?.trim() ?? `unit ${unit}`
        questions.push(
          { unit, type: 'qa', difficulty: 'easy', front: `What is ${title}?`, back: `${title}, explained.` },
          { unit, type: 'qa', difficulty: 'medium', front: `Why does ${title} matter?`, back: 'It matters.' },
        )
      }
      content = JSON.stringify({ questions })
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
  return asked
}

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

/** Asks for cards on the note « Cells » of Biology, then opens « Suggested cards » once they are there. */
async function suggest(page: Page, project: string) {
  await harness.seed(page, {
    courses: [
      {
        title: 'Biology',
        notes: [{ title: 'Cells', body: '# Membranes\n\nA bilayer of lipids.\n\n# Transport\n\nPumps need ATP.' }],
      },
      { title: 'Chemistry' },
    ],
  })
  const asked = await mockProvider(page)
  await configureAi(page, LLM)
  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .click()
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page.getByRole('main').getByRole('link', { name: /Cells/ }).click()
  await page.getByRole('main').getByRole('button', { name: 'Suggest cards' }).click()
  const chat = chatPanel(page, project)
  await expect(chat.getByText(/cards? wait in Suggested cards\./)).toBeVisible()
  // On a phone the chat covers the screen: closed, to see the inbox.
  if (isPhone(project)) {
    await page.keyboard.press('Escape')
    await expect(chat).toBeHidden()
  }
  expect(asked).toHaveLength(1)
  await page.goto('./#/inbox')
  await expect(page.getByRole('heading', { level: 1, name: 'Suggested cards' })).toBeVisible()
  await expect(page.getByText('What is Membranes?')).toBeVisible()
  await expect(page.getByText('Why does Transport matter?')).toBeVisible()
}

test('adding a PDF or a photo asks no model and queues nothing', async ({ page }) => {
  const errors = watchErrors(page)
  const asked = await mockProvider(page)
  await configureAi(page, LLM)
  await page.goto('./#/')
  await createCourse(page, 'Quiet')
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByLabel('Add files').setInputFiles([PDF, PHOTO])
  await expect(page.getByText('2 files added')).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(asked).toEqual([])
  expect(await storedJobs(page)).toBe(0)
  await page.goto('./#/inbox')
  await expect(page.getByRole('heading', { name: 'No suggested cards' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'Generate cards' })).toBeVisible()
  expect(errors).toEqual([])
})

test('« Suggest cards » fills the inbox; Add (then Undo), Add all to another course, Reject', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await suggest(page, info.project.name)
  const main = page.getByRole('main')
  const membranes = main.getByRole('region', { name: /^Section 1 \(2\)$/ })
  const transport = main.getByRole('region', { name: /^Section 2 \(2\)$/ })
  await expect(membranes).toBeVisible()
  await expect(transport).toBeVisible()
  // The answers are folded under the questions, rendered.
  await expect(membranes.getByText('Membranes, explained.')).toBeHidden()
  for (const summary of await membranes.locator('summary').all()) await summary.click()
  await expect(membranes.getByText('Membranes, explained.')).toBeVisible()
  expect(await seriousViolations(page)).toEqual([])

  // Add at once, with a moment to undo (the cards of a unit come in no fixed order: they were written together).
  const question = async (n: number) =>
    (await membranes.locator('[data-draft]').nth(n).locator('[id$="-q"]').textContent())?.replace(/^Question:\s*/, '')
  const added = (await question(0))?.trim() ?? ''
  const other = (await question(1))?.trim() ?? ''
  await membranes.getByRole('button', { name: 'Add card 1, Section 1' }).click()
  await expect(page.getByRole('status').getByText('1 card added to Biology.')).toBeVisible()
  await expect(main.getByText(added, { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(main.getByText(added, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add card 1, Section 1' }).click()
  await page.getByRole('button', { name: 'Dismiss' }).click()

  // A whole section to another course.
  await main.getByLabel('Add to').selectOption({ label: 'Chemistry' })
  await main.getByRole('button', { name: 'Add all 2 cards of Section 2' }).click()
  await expect(page.getByRole('status').getByText('2 cards added to Chemistry.')).toBeVisible()
  await page.getByRole('button', { name: 'Dismiss' }).click()

  // Rejected for good: never suggested again.
  await main.getByRole('button', { name: 'Reject card 1, Section 1' }).click()
  await expect(page.getByRole('status').getByText(/1 card rejected/)).toBeVisible()
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByRole('heading', { name: 'No suggested cards' })).toBeVisible()

  await page.goto('./#/courses')
  await main.getByRole('link', { name: /Chemistry/ }).click()
  await expect(main.getByText('What is Transport?')).toBeVisible()
  await expect(main.getByText('Why does Transport matter?')).toBeVisible()
  // The card undone once was added once only; the rejected one is nowhere.
  await page.goto('./#/courses')
  await main.getByRole('link', { name: /Biology/ }).click()
  await expect(main.getByText(added, { exact: true })).toHaveCount(1)
  await expect(main.getByText(other, { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('keys on a focused card: A adds, R rejects, E edits in the editor, ↓ moves on', async ({ page }, info) => {
  test.skip(info.project.name === 'webkit-iphone', 'no keyboard')
  const errors = watchErrors(page)
  await suggest(page, info.project.name)
  const main = page.getByRole('main')
  const section = (n: number) => main.getByRole('region', { name: new RegExp(`^Section ${n} \\(\\d\\)$`) })
  const focused = main.locator('[data-draft]:focus')
  /** The question a card asks (the cards of a unit come in no fixed order: written together). */
  const asks = (card: ReturnType<typeof main.locator>) =>
    card.locator('[id$="-q"]').evaluate((el) => (el.textContent ?? '').replace(/^Question:\s*/, '').trim())

  const first = section(1).locator('[data-draft]').first()
  const added = await asks(first)
  await first.focus()
  await page.keyboard.press('a')
  await expect(page.getByRole('status').getByText('1 card added to Biology.')).toBeVisible()
  // The next card has the focus: the other one of Section 1.
  await expect(section(1).locator('[data-draft]:focus')).toHaveCount(1)
  const rejected = await asks(focused)
  expect(rejected).not.toBe(added)
  await page.keyboard.press('r')
  await expect(page.getByRole('status').getByText(/1 card rejected/)).toBeVisible()
  // On to Section 2, then ↓ to its second card, edited in the editor and added.
  await expect(section(2).locator('[data-draft]:focus')).toHaveCount(1)
  const third = await asks(focused)
  await page.keyboard.press('ArrowDown')
  await expect(section(2).locator('[data-draft]:focus')).toHaveCount(1)
  const edited = await asks(focused)
  expect(edited).not.toBe(third)
  await page.keyboard.press('e')
  const question = main.getByRole('textbox', { name: 'Question' })
  await expect(question).toBeVisible()
  await question.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' Really')
  await main.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await page.goto('./#/courses')
  await main.getByRole('link', { name: /Biology/ }).click()
  await expect(main.getByText(`${edited} Really`)).toBeVisible()
  await expect(main.getByText(added, { exact: true })).toBeVisible()
  await expect(main.getByText(rejected, { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('the inbox in dark mode and in German on a phone: readable, nothing cut off', async ({ page }, info) => {
  await suggest(page, info.project.name)
  await page.emulateMedia({ colorScheme: 'dark' })
  expect(await seriousViolations(page)).toEqual([])
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto('./?locale=de#/inbox')
  await expect(page.getByRole('heading', { level: 1, name: 'Vorgeschlagene Karten' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await seriousViolations(page)).toEqual([])
})
