import { join } from 'node:path'
import { expect, type Page, type Route, test } from '@playwright/test'
import { aiSearch, configureAi, openModels, providerGroup, providerPicker } from './support/ai'
import { createCourse } from './support/page'

test.use({ serviceWorkers: 'block' })

const LLM = 'https://llm.mock.test/v1'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}
const FIXTURES = join(import.meta.dirname, 'fixtures')
/** 3000 × 1500: stored at 2048 × 1024, sent to the model at 1024 × 512. */
const LARGE = join(FIXTURES, 'large.png')

const DESCRIPTION = {
  kind: 'table',
  title: 'Krebs cycle steps',
  transcription: '| Step | Molecule |\n| --- | --- |\n| 1 | Citrate |\n| 2 | Isocitrate |',
  explanation: 'The cycle oxidises acetyl-CoA to make NADH.',
  keyPoints: ['Citrate starts the cycle', 'It runs in the mitochondria'],
}
const CARDS = {
  cards: [
    { kind: 'basic', front: 'What starts the Krebs cycle?', back: 'Citrate' },
    { kind: 'basic', front: 'What starts the Krebs cycle ?', back: 'Citrate formation' },
    { kind: 'cloze', front: 'The Krebs cycle runs in the {{c1::mitochondria}}.', back: '' },
  ],
}

const usage = { prompt_tokens: 1600, completion_tokens: 400 }

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

function sse(content: string): string {
  const base = { id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, model: 'claude-haiku-5-5' }
  const events: Record<string, unknown>[] = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base, choices: [], usage },
  ]
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`
}

type Part = { type: string; text?: string; image_url?: { url: string } }
interface Body {
  stream?: boolean
  messages: { role: string; content: string | Part[] }[]
}

interface Sent {
  text: string
  images: string[]
}

function read(body: Body): Sent {
  const text: string[] = []
  const images: string[] = []
  for (const m of body.messages) {
    if (typeof m.content === 'string') text.push(m.content)
    else
      for (const p of m.content) {
        if (p.text) text.push(p.text)
        if (p.image_url) images.push(p.image_url.url)
      }
  }
  return { text: text.join('\n'), images }
}

/** Width and height of a JPEG sent as a data URL (from its SOF marker). */
function jpegSize(dataUrl: string): { mime: string; width: number; height: number } {
  const [head = '', b64 = ''] = dataUrl.split(',')
  const mime = /^data:([^;]+);base64$/.exec(head)?.[1] ?? ''
  const bytes = Buffer.from(b64, 'base64')
  let i = 2
  while (i < bytes.length) {
    const marker = bytes[i + 1] ?? 0
    const length = bytes.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xc2)
      return { mime, height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
    i += 2 + length
  }
  return { mime, width: 0, height: 0 }
}

/** The photo id a prompt introduced (`<<<PHOTO id="…">>>` or a `<<<SOURCE id="…">>>` holding its reading). */
function citedPhoto(text: string): string {
  return /<<<SOURCE id="([^"]+)">>>\nKrebs cycle steps/.exec(text)?.[1] ?? 'missing-photo'
}

async function mockProvider(page: Page, hold?: Promise<void>): Promise<Sent[]> {
  const sent: Sent[] = []
  await page.route(`${LLM}/**`, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    expect(req.headers().authorization).toBe('Bearer sk-test-123')
    const body = req.postDataJSON() as Body
    const s = read(body)
    sent.push(s)
    if (hold) await hold
    let out: unknown = 'OK'
    if (s.text.includes('photographed course material')) out = DESCRIPTION
    else if (s.text.includes('flashcards from photos')) out = CARDS
    else if (s.text.includes('patient tutor')) {
      const id = citedPhoto(s.text)
      out = {
        title: 'Krebs cycle',
        summary: 'How cells oxidise acetyl-CoA.',
        points: [{ heading: 'Citrate', explanation: 'Citrate starts the cycle.', sourceRef: { sourceId: id } }],
      }
    }
    const json = typeof out === 'string' ? out : JSON.stringify(out)
    try {
      if (body.stream) {
        return await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'text/event-stream' },
          body: sse(json),
        })
      }
      return await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        json: completion(json),
      })
    } catch (error) {
      // A request the page cancelled meanwhile can no longer be answered; anything else is a failure.
      if (!(hold && error instanceof Error && /Route is already handled|Target .* closed|aborted/i.test(error.message)))
        throw error
    }
  })
  return sent
}

/** A course with photos added through the gallery; returns the course id. */
async function courseWithPhotos(page: Page, title: string, files: string[]): Promise<string> {
  await page.goto('./#/')
  await createCourse(page, title)
  const courseId = decodeURIComponent(/#\/course\/([^/?]+)/.exec(page.url())?.[1] ?? '')
  expect(courseId).not.toBe('')
  await page.goto(`./#/course/${encodeURIComponent(courseId)}/photos`)
  await page.locator('input[type="file"][multiple]').setInputFiles(files)
  await expect(page.getByTestId('photo-tile').locator('img')).toHaveCount(files.length)
  return courseId
}

async function openFirstPhoto(page: Page): Promise<string> {
  await page.getByTestId('photo-tile').first().getByRole('link').click()
  await expect(page).toHaveURL(/#\/photo\//)
  const title = (await page.getByRole('heading', { level: 1 }).textContent()) ?? ''
  expect(title).not.toBe('')
  return title
}

const panel = (page: Page) => page.getByRole('region', { name: 'Explain with AI' })

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'Explain with AI' }).click()
  await expect(panel(page)).toBeVisible()
}

test('a photo is explained from a reduced copy, after its cost is shown, then cited in Understand', async ({
  page,
}) => {
  const sent = await mockProvider(page)
  await configureAi(page, LLM)
  // Since S-044 adding a document proposes questions on its own (auto-questions.spec.ts): off for this manual flow.
  await page.getByRole('radio', { name: 'Do nothing' }).check({ force: true })
  await courseWithPhotos(page, 'Biochemistry', [LARGE])
  const title = await openFirstPhoto(page)
  await openPanel(page)

  const p = panel(page)
  await expect(p.getByText(/Estimated cost: \$.* · Claude Haiku 5\.5/).first()).toBeVisible()
  await expect(p.getByText('The photo is sent reduced to 1,024 px at most.')).toBeVisible()
  expect(sent).toHaveLength(0)

  // Keyboard: the action runs from Enter, and focus lands on the result for VoiceOver.
  await p.getByRole('button', { name: 'Explain this photo' }).focus()
  await page.keyboard.press('Enter')
  await expect(p.getByText('Krebs cycle steps')).toBeVisible()
  await expect(p.getByRole('heading', { name: 'Text on the photo' })).toBeVisible()
  await expect(p.getByRole('table').getByRole('cell', { name: 'Citrate', exact: true })).toBeVisible()
  await expect(p.getByText('The cycle oxidises acetyl-CoA to make NADH.')).toBeVisible()
  await expect(p.getByRole('listitem').filter({ hasText: 'Citrate starts the cycle' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.textContent?.includes('Krebs cycle steps') ?? false))
    .toBe(true)

  // One request, with the photo as an image no larger than 1024 px, turned into a JPEG.
  expect(sent).toHaveLength(1)
  const request = sent[0]
  expect(request?.images).toHaveLength(1)
  expect(jpegSize(request?.images[0] ?? '')).toEqual({ mime: 'image/jpeg', width: 1024, height: 512 })
  expect(request?.text).toContain('Course: Biochemistry')

  // What was read is kept: reopening the panel shows it without a new request.
  await p.getByRole('button', { name: 'Close' }).click()
  await openPanel(page)
  await expect(panel(page).getByText('Krebs cycle steps')).toBeVisible()
  await expect(panel(page).getByRole('button', { name: 'Explain again' })).toBeVisible()
  expect(sent).toHaveLength(1)

  // Understand grounds in the photo and cites it: thumbnail and link back to the photo.
  await expect(panel(page).getByText('Kept on this device: Understand can now use and cite this photo.')).toBeVisible()
  await panel(page).getByRole('link', { name: 'Understand' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Study tools' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: title })).toBeChecked()
  await expect(page.getByText('Includes what AI read on 1 photo.')).toBeVisible()
  await page.getByLabel('What do you want to understand?').fill('Krebs cycle')
  await page.getByRole('button', { name: 'Explain', exact: true }).click()
  const fiche = page.getByRole('article', { name: 'Explanation' })
  const cite = fiche.getByRole('link', { name: `Open photo: ${title}` })
  await expect(cite).toBeVisible()
  await expect(cite.locator('img')).toBeVisible()
  expect(sent.at(-1)?.text).toContain('| 1 | Citrate |')
  expect(sent.at(-1)?.images).toHaveLength(0)
  await cite.click()
  await expect(page).toHaveURL(/#\/photo\//)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
})

test('cards from several photos: deduped drafts, saved only when confirmed', async ({ page }) => {
  const sent = await mockProvider(page)
  await configureAi(page, LLM)
  // Since S-044 adding a document proposes questions on its own (auto-questions.spec.ts): off for this manual flow.
  await page.getByRole('radio', { name: 'Do nothing' }).check({ force: true })
  const courseId = await courseWithPhotos(page, 'Metabolism', [LARGE, LARGE])
  await openFirstPhoto(page)
  await openPanel(page)
  const p = panel(page)

  await expect(p.getByRole('heading', { name: 'Create cards from this photo' })).toBeVisible()
  const others = p.getByRole('group', { name: 'Photos to use' }).getByRole('checkbox')
  await expect(others).toHaveCount(2)
  await expect(others.first()).toBeChecked()
  await expect(others.first()).toBeDisabled()
  const before =
    (await p
      .getByText(/Estimated cost: \$/)
      .last()
      .textContent()) ?? ''
  await others.nth(1).check()
  await expect(p.getByText('2 photos in one request.')).toBeVisible()
  await expect(p.getByText(/Estimated cost: \$/).last()).not.toHaveText(before)

  await p.getByRole('button', { name: 'Suggest cards' }).click()
  await expect(p.getByText('2 cards generated')).toBeVisible()
  await expect(p.getByText('1 duplicate removed')).toBeVisible()
  expect(sent.at(-1)?.images).toHaveLength(2)

  // Nothing is saved until confirmed: discarding leaves the course without cards.
  await p.getByRole('button', { name: 'Discard' }).click()
  await page.goto(`./#/course/${encodeURIComponent(courseId)}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Metabolism' })).toBeVisible()
  await expect(page.getByText('What starts the Krebs cycle?')).toHaveCount(0)

  await page.goBack()
  await openPanel(page)
  await panel(page).getByRole('button', { name: 'Suggest cards' }).click()
  await expect(panel(page).getByText('2 cards generated')).toBeVisible()
  await panel(page).getByLabel('Front of card 1').fill('Which molecule starts the Krebs cycle?')
  await panel(page).getByRole('button', { name: 'Save 2 cards' }).click()
  await expect(panel(page).getByText('2 cards saved.')).toBeVisible()
  await panel(page).getByRole('link', { name: 'Open course' }).click()
  await expect(page.getByText('Which molecule starts the Krebs cycle?')).toBeVisible()
})

test('a running request can be cancelled; offline, the actions wait for a connection', async ({ page, context }) => {
  let release: () => void = () => undefined
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const sent = await mockProvider(page, hold)
  await configureAi(page, LLM)
  // Since S-044 adding a document proposes questions on its own (auto-questions.spec.ts): off for this manual flow.
  await page.getByRole('radio', { name: 'Do nothing' }).check({ force: true })
  await courseWithPhotos(page, 'Genetics', [LARGE])
  await openFirstPhoto(page)
  await openPanel(page)
  const p = panel(page)

  await p.getByRole('button', { name: 'Explain this photo' }).click()
  await expect(p.getByRole('status').filter({ hasText: 'Reading the photo…' })).toBeVisible()
  await expect(p.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect.poll(() => sent.length).toBe(1)
  await p.getByRole('button', { name: 'Cancel' }).click()
  await expect(p.getByText('Reading the photo…')).toHaveCount(0)
  await expect(p.getByRole('button', { name: 'Explain this photo' })).toBeEnabled()
  // Focus goes back to the action, never to the top of the page.
  await expect(p.getByRole('button', { name: 'Explain this photo' })).toBeFocused()
  release()
  await expect(p.getByText('Krebs cycle steps')).toHaveCount(0)
  await expect(p.getByRole('alert')).toHaveCount(0)

  await context.setOffline(true)
  await expect(
    p.getByText('You’re offline. Explaining a photo and suggesting cards from it need a connection.'),
  ).toBeVisible()
  await expect(p.getByRole('button', { name: 'Explain this photo' })).toBeDisabled()
  await expect(p.getByRole('button', { name: 'Suggest cards' })).toBeDisabled()
  await context.setOffline(false)
  await expect(p.getByRole('button', { name: 'Explain this photo' })).toBeEnabled()
})

test('without a model that reads images, the panel links to the AI settings', async ({ page }) => {
  await courseWithPhotos(page, 'Anatomy', [LARGE])
  const photoUrl = await (async () => {
    await openFirstPhoto(page)
    return page.url()
  })()
  await openPanel(page)
  await expect(
    panel(page).getByText('Set up an AI model that reads images to explain photos and turn them into cards.'),
  ).toBeVisible()
  await expect(panel(page).getByRole('button', { name: 'Explain this photo' })).toHaveCount(0)

  // A text-only model: the panel says so and leads to the settings.
  await page.goto('./#/settings/ai')
  await openModels(page)
  await aiSearch(page).fill('302 deepseek v3.2')
  const row = providerGroup(page, '302.AI').getByRole('button', { name: /^DeepSeek V3\.2 deepseek-v3\.2/ })
  await row.click()
  await page.getByLabel('API key').fill('sk-test-123')
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect(providerPicker(page)).toHaveValue('302ai')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved on this device.')).toBeVisible()

  await page.goto(photoUrl)
  await openPanel(page)
  await expect(
    panel(page).getByText(
      'DeepSeek V3.2 reads text only. To explain photos, choose a model that reads images in the AI settings.',
    ),
  ).toBeVisible()
  await panel(page).getByRole('link', { name: 'Open AI settings' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible()
})
