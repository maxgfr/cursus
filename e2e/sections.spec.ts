import { expect, type Page, type Route, test } from '@playwright/test'
import { configureAi } from './support/ai'
import { createCourse, isPhone, seriousViolations, typeInto, watchErrors } from './support/page.ts'

test.use({ serviceWorkers: 'block' })

async function openToday(page: Page) {
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
}

/** Creates a section inside the course or section on screen, and lands on it. */
async function newSection(page: Page, name: string) {
  await page.getByRole('button', { name: 'New section' }).click()
  const dialog = page.getByRole('dialog', { name: 'New section' })
  await dialog.getByLabel('Section name').fill(name)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

async function openSection(page: Page, name: string) {
  await page
    .getByRole('main')
    .getByRole('link', { name: new RegExp(`^${name}`) })
    .click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

async function crumb(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Location' }).getByRole('link', { name, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

/** Writes a card in the course or section on screen; Save brings the editor back here. */
async function newCard(page: Page, front: string) {
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).first().click()
  await typeInto(page, 'Front', front)
  await typeInto(page, 'Back', 'Answer')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Card saved.')).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: new RegExp(front) })).toBeVisible()
}

async function settings(page: Page) {
  await page.getByRole('button', { name: 'Section settings' }).click()
  return page.getByRole('dialog', { name: 'Section settings' })
}

/** The local date `days` study days from now: a study day starts at 04:00, as in the app. */
function isoIn(page: Page, days: number): Promise<string> {
  return page.evaluate((n) => {
    const d = new Date()
    if (d.getHours() < 4) d.setDate(d.getDate() - 1)
    d.setDate(d.getDate() + n)
    const pad = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }, days)
}

test('Nested sections: three levels, breadcrumb navigation, reload and axe in light and dark', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Law')
  await newSection(page, 'Contracts')
  await newSection(page, 'Formation')
  await newSection(page, 'Offer')

  // Course › Contracts › Formation › Offer; on a phone the middle crumbs fold away.
  const nav = page.getByRole('navigation', { name: 'Location' })
  await expect(nav.getByRole('link', { name: 'Law', exact: true })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Formation', exact: true })).toBeVisible()
  await expect(nav.locator('[aria-current="page"]')).toHaveText('Offer')
  const middle = nav.getByRole('link', { name: 'Contracts', exact: true })
  if (isPhone(info.project.name)) await expect(middle).toBeHidden()
  else await expect(middle).toBeVisible()
  expect(await seriousViolations(page)).toEqual([])

  await crumb(page, 'Formation')
  await expect(page.getByRole('main').getByRole('link', { name: /^Offer/ })).toBeVisible()
  await crumb(page, 'Law')
  await expect(page.getByRole('navigation', { name: 'Location' })).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('link', { name: /^Contracts/ })).toBeVisible()

  // Reload: the tree is in the workspace, not in memory.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Law' })).toBeVisible()
  await openSection(page, 'Contracts')
  await openSection(page, 'Formation')
  await openSection(page, 'Offer')
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Formation' })).toBeVisible()

  await page.emulateMedia({ colorScheme: 'dark' })
  expect(await seriousViolations(page)).toEqual([])
  await (await settings(page)).getByRole('button', { name: 'Move to…' }).click()
  await expect(page.getByRole('dialog', { name: 'Move “Formation” to…' })).toBeVisible()
  expect(await seriousViolations(page, 'dialog[open]')).toEqual([])
  await page.emulateMedia({ colorScheme: 'light' })
  expect(await seriousViolations(page, 'dialog[open]')).toEqual([])
  expect(errors).toEqual([])
})

test('Move: a note to another section, a section under another, and a cycle refused calmly', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Law')
  await newSection(page, 'Torts')
  await crumb(page, 'Law')
  await newSection(page, 'Contracts')
  await newSection(page, 'Formation')
  await crumb(page, 'Law')

  // A note written at the course root moves into Torts.
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: 'Write a note' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled note' })).toBeVisible()
  await page.getByRole('button', { name: 'Move to…' }).click()
  const sheet = page.getByRole('dialog', { name: 'Move to' })
  await expect(sheet.getByRole('button', { name: 'Law (current)' })).toHaveAttribute('aria-current', 'location')
  await sheet.getByRole('button', { name: 'Law › Torts', exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'Moved to Law › Torts.' })).toBeVisible()
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Torts' })).toBeVisible()
  await page.getByRole('radio', { name: 'Sources' }).check()
  await expect(page.getByRole('main').getByRole('link', { name: /Untitled note/ })).toBeVisible()

  // Contracts can't go inside its own child: explained, nothing moves.
  await crumb(page, 'Law')
  await openSection(page, 'Contracts')
  await (await settings(page)).getByRole('button', { name: 'Move to…' }).click()
  const move = page.getByRole('dialog', { name: 'Move “Contracts” to…' })
  await move.getByRole('button', { name: 'Law › Contracts › Formation', exact: true }).click()
  await expect(move.getByRole('alert')).toHaveText(/can’t go inside itself/)
  await expect(move).toBeVisible()
  // Under Torts it goes.
  await move.getByRole('button', { name: 'Law › Torts', exact: true }).click()
  await expect(move).toBeHidden()
  const nav = page.getByRole('navigation', { name: 'Location' })
  await expect(nav.getByRole('link', { name: 'Torts', exact: true })).toBeVisible()
  await expect(nav.locator('[aria-current="page"]')).toHaveText('Contracts')
  await crumb(page, 'Torts')
  await expect(page.getByRole('main').getByRole('link', { name: /^Contracts/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('Start on a section reviews only that section and its descendants', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Law')
  await newCard(page, 'Root question')
  await newSection(page, 'Contracts')
  await newCard(page, 'Contract question')
  await newSection(page, 'Formation')
  await newCard(page, 'Offer question')
  await crumb(page, 'Contracts')

  await expect(page.getByTestId('place-meta')).toContainText('2 cards')
  await expect(page.getByTestId('place-meta')).toContainText('2 due today')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByTestId('remaining')).toHaveText('2 left')
  const seen: string[] = []
  for (let i = 0; i < 2; i++) {
    const q = page.getByTestId('question')
    await expect(q).toBeVisible()
    seen.push((await q.innerText()).trim())
    await page.getByRole('button', { name: 'Show answer' }).click()
    // Easy: a new card graduates at once, so the session ends instead of waiting for a learning step.
    await page.getByRole('button', { name: /^Easy/ }).click()
  }
  expect(seen.sort()).toEqual(['Contract question', 'Offer question'])
  await expect(page.getByRole('heading', { name: /Session complete|All caught up/ })).toBeVisible()
  // The root card is still due on Today.
  await openToday(page)
  await expect(page.getByRole('heading', { level: 2, name: '1 card due today' })).toBeVisible()
  expect(errors).toEqual([])
})

const LLM = 'https://llm.mock.test/v1'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

function sse(content: string): string {
  const base = { id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, model: 'claude-haiku-5-5' }
  const events = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10 } },
  ]
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`
}

interface Body {
  stream?: boolean
  messages: { role: string; content: string | { type: string; text?: string }[] }[]
}

async function mockProvider(page: Page): Promise<string[]> {
  const prompts: string[] = []
  await page.route(`${LLM}/**`, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const body = req.postDataJSON() as Body
    const text = body.messages
      .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((c) => c.text ?? '').join('')))
      .join('\n')
    prompts.push(text)
    const note = /<<<SOURCE id="([^"]+)">>>/.exec(text)?.[1] ?? 'missing'
    const json = text.includes('patient tutor')
      ? JSON.stringify({
          title: 'Leaves',
          summary: 'Leaves make sugar.',
          points: [{ heading: 'Chlorophyll', explanation: 'It captures light.', sourceRef: { sourceId: note } }],
        })
      : 'OK'
    const usage = { prompt_tokens: 10, completion_tokens: 10 }
    if (body.stream)
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sse(json) })
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      json: {
        id: 'cmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'claude-haiku-5-5',
        choices: [{ index: 0, message: { role: 'assistant', content: json }, finish_reason: 'stop' }],
        usage,
      },
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
  return prompts
}

async function writeNote(page: Page, text: string) {
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: 'Write a note' }).click()
  await typeInto(page, 'Source', text)
  await expect(page.getByRole('textbox', { name: 'Source' })).toContainText(text)
  await page.getByRole('link', { name: 'Back' }).click()
}

test('a study sheet from a section is grounded in that section’s sources only', async ({ page }) => {
  const errors = watchErrors(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openToday(page)
  await createCourse(page, 'Botany')
  await writeNote(page, 'Roots drink water ZEBRA.')
  await expect(page.getByRole('heading', { level: 1, name: 'Botany' })).toBeVisible()
  await newSection(page, 'Leaves')
  await newSection(page, 'Cells')
  await writeNote(page, 'Chlorophyll captures light in leaf cells.')
  await crumb(page, 'Leaves')

  await page.getByRole('radio', { name: 'Study sheets' }).check()
  await page.getByRole('main').getByRole('link', { name: 'New study sheet' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'New study sheet' })).toBeVisible()
  await page.getByText('Sources: all of Leaves').click()
  await expect(page.getByLabel('Section', { exact: true })).toHaveValue(/.+/)
  await expect(page.getByLabel('Section', { exact: true }).locator('option:checked')).toHaveText('Leaves')
  // Leaves itself has no note; its child Cells has one: descendants count, the course root's note doesn't.
  await expect(page.getByRole('checkbox')).toHaveCount(1)
  await expect(page.getByRole('checkbox', { name: 'Untitled note' })).toBeChecked()
  await page.getByLabel('What should the sheet cover?').fill('photosynthesis')
  await page.getByRole('button', { name: 'Write the sheet', exact: true }).click()
  await expect(
    page.getByRole('article', { name: 'Study sheet' }).getByRole('heading', { name: 'Leaves' }),
  ).toBeVisible()
  const prompt = prompts.find((p) => p.includes('patient tutor')) ?? ''
  expect(prompt).toContain('Chlorophyll captures light in leaf cells.')
  expect(prompt).not.toContain('ZEBRA')
  expect(errors.filter((e) => !/models\.dev|catalog/i.test(e))).toEqual([])
})

test('a new study sheet starts from the Study sheets tab, not the header, and is saved to the course', async ({
  page,
}) => {
  const errors = watchErrors(page)
  const prompts = await mockProvider(page)
  await configureAi(page, LLM)
  await openToday(page)
  await createCourse(page, 'Biology')
  await writeNote(page, 'Chlorophyll captures light in leaf cells.')
  await newCard(page, 'Root question')
  const main = page.getByRole('main')
  const toSheet = main.locator('a[href*="#/understand"]')

  // The course and section headers offer the study actions, never a study sheet.
  await expect(main.getByRole('link', { name: 'Quiz me' })).toBeVisible()
  await expect(toSheet).toHaveCount(0)
  await newSection(page, 'Stems')
  await newCard(page, 'Stem question')
  await expect(main.getByRole('link', { name: 'Quiz me' })).toBeVisible()
  await expect(toSheet).toHaveCount(0)
  await crumb(page, 'Biology')
  await expect(toSheet).toHaveCount(0)

  // The Study sheets tab does, scoped to the course.
  await page.getByRole('radio', { name: 'Study sheets' }).check()
  const start = main.getByRole('link', { name: 'New study sheet' })
  await expect(start).toHaveAttribute('href', /#\/understand\?course=[^&]+$/)
  await start.click()
  await expect(page.getByRole('heading', { level: 1, name: 'New study sheet' })).toBeVisible()

  // The sources start folded, their summary saying what the sheet will use.
  const summary = page.getByText('Sources: all of Biology')
  await expect(summary).toBeVisible()
  await expect(page.locator('details').filter({ has: summary })).not.toHaveAttribute('open')
  await expect(page.getByRole('combobox', { name: 'Course', exact: true })).toBeHidden()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await summary.click()
  await expect(page.getByLabel('Course', { exact: true }).locator('option:checked')).toHaveText('Biology')
  await expect(page.getByRole('checkbox', { name: 'Untitled note' })).toBeChecked()

  await page.getByLabel('What should the sheet cover?').fill('leaves')
  await page.getByRole('button', { name: 'Write the sheet', exact: true }).click()
  const sheet = page.getByRole('article', { name: 'Study sheet' })
  await expect(sheet.getByRole('heading', { name: 'Leaves' })).toBeVisible()
  await expect(sheet.getByRole('heading', { name: 'Chlorophyll' })).toBeVisible()
  await expect(sheet.getByRole('link', { name: 'Open source: Untitled note' })).toBeVisible()

  // « Rewrite » asks again.
  const asked = () => prompts.filter((p) => p.includes('patient tutor')).length
  expect(asked()).toBe(1)
  await page.getByRole('button', { name: 'Rewrite' }).click()
  await expect.poll(asked).toBe(2)
  await expect(sheet.getByRole('heading', { name: 'Chlorophyll' })).toBeVisible()

  const save = page.getByRole('button', { name: 'Save to Biology' })
  await save.click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved in the study sheets of Biology.' })).toBeVisible()
  await expect(save).toBeDisabled()
  await page.getByRole('link', { name: 'Open study sheets' }).click()

  // Back in the course, on its study sheets: the sheet is there, and reads as written.
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Study sheets' })).toBeChecked()
  await expect(main.getByRole('link', { name: 'New study sheet' })).toBeVisible()
  await main.getByRole('button', { name: /^Leaves/ }).click()
  const read = page.getByRole('dialog', { name: 'Leaves' })
  await expect(read.getByRole('heading', { name: 'Chlorophyll' })).toBeVisible()
  await expect(read.getByText('It captures light.')).toBeVisible()
  await expect(read.getByText('Untitled note')).toBeVisible()
  expect(errors.filter((e) => !/models\.dev|catalog/i.test(e))).toEqual([])
})

test('A section exam date shows on the section and leads Today', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Law')
  await newCard(page, 'Root question')
  await newSection(page, 'Contracts')
  await newCard(page, 'Contract question')
  const s = await settings(page)
  await s.getByLabel('Exam date').fill(await isoIn(page, 5))
  await s.getByRole('button', { name: 'Save' }).click()
  await expect(s).toBeHidden()
  await expect(page.getByTestId('place-meta')).toContainText('5 days left')
  await crumb(page, 'Law')
  await expect(page.getByRole('main').getByRole('link', { name: /^Contracts/ })).toContainText('5 days left')

  await openToday(page)
  await expect(page.getByRole('heading', { level: 2, name: '2 cards due today' })).toBeVisible()
  await expect(page.getByTestId('exam-lead')).toHaveText('incl. 1 in Contracts · 5 days left')
  expect(errors).toEqual([])
})

test('Trashing a section hides its content; restoring brings it back', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Law')
  await newCard(page, 'Root question')
  await newSection(page, 'Contracts')
  await newCard(page, 'Contract question')
  await newSection(page, 'Formation')
  await newCard(page, 'Offer question')
  await crumb(page, 'Contracts')

  await (await settings(page)).getByRole('button', { name: 'Move section to the trash' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Law' })).toBeVisible()
  await expect(page.getByText('Section moved to the trash.')).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: /^Contracts/ })).toHaveCount(0)
  await expect(page.getByTestId('place-meta')).toContainText('1 card')
  await openToday(page)
  await expect(page.getByRole('heading', { level: 2, name: '1 card due today' })).toBeVisible()

  // Restored from the course, after a reload: the whole subtree is back.
  await page.reload()
  await page.getByRole('main').getByRole('link', { name: /Law/ }).click()
  await page.getByRole('button', { name: 'Restore Contracts' }).click()
  await expect(page.getByRole('main').getByRole('link', { name: /^Contracts/ })).toContainText('2 cards')
  await expect(page.getByTestId('place-meta')).toContainText('3 cards')
  await openToday(page)
  await expect(page.getByRole('heading', { level: 2, name: '3 cards due today' })).toBeVisible()
  expect(errors).toEqual([])
})

test('A new card whose section went to the trash meanwhile is saved in the nearest live place, and says so', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Law')
  await newSection(page, 'Contracts')
  await newSection(page, 'Formation')
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).first().click()
  await typeInto(page, 'Front', 'Offer and acceptance?')
  await page.waitForTimeout(400) // the draft is kept on the device a moment after typing
  const editor = page.url()

  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'Formation' })).toBeVisible()
  await crumb(page, 'Contracts')
  await (await settings(page)).getByRole('button', { name: 'Move section to the trash' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Law' })).toBeVisible()

  // Back to the draft (history, another tab): the subset is in the trash, the card goes to the course.
  await page.goto(editor)
  await expect(page.getByRole('status')).toContainText(
    'The section was moved to the trash; the card will be saved in Law.',
  )
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Law' })).toBeVisible()
  await expect(page.getByText('Card saved.')).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: /Offer and acceptance\?/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('A trashed section is listed in the Trash with its path and contents, restorable from there', async ({ page }) => {
  const errors = watchErrors(page)
  await openToday(page)
  await createCourse(page, 'Law')
  await newSection(page, 'Contracts')
  await newCard(page, 'Contract question')
  await newSection(page, 'Formation')
  await newCard(page, 'Offer question')
  await crumb(page, 'Contracts')
  await (await settings(page)).getByRole('button', { name: 'Move section to the trash' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Law' })).toBeVisible()

  await page.goto('./#/trash')
  const row = page.getByRole('listitem').filter({ hasText: 'Law › Contracts' })
  await expect(row).toContainText('Section · 1 section, 2 cards')
  await page.getByRole('button', { name: 'Delete Law › Contracts forever' }).click()
  const sheet = page.getByRole('dialog', { name: 'Delete forever?' })
  await expect(sheet).toContainText('Everything filed in it goes with it: 1 section, 2 cards.')
  await expect(sheet).toContainText('Cursus never rewrites your sync history')
  await sheet.getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('button', { name: 'Restore Law › Contracts' }).click()
  await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible()
  await page.goto('./#/')
  await page.getByRole('main').getByRole('link', { name: /Law/ }).click()
  await expect(page.getByRole('main').getByRole('link', { name: /^Contracts/ })).toContainText('2 cards')
  expect(errors).toEqual([])
})
