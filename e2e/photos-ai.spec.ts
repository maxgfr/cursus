import { join } from 'node:path'
import { expect, type Page, type Route, test } from '@playwright/test'
import { aiSearch, chatPanel, configureAi, openModels, providerGroup, providerPicker, restoreChat } from './support/ai'
import { createCourse, isPhone } from './support/page'

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
  return (
    /<<<SOURCE id="([^"]+)">>>\nKrebs cycle steps/.exec(text)?.[1] ??
    /^<<<PHOTO id="([^"]+)">>>/m.exec(text)?.[1] ??
    'missing-photo'
  )
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
    else if (s.text.includes('study tutor')) out = `Citrate starts the cycle [[source:${citedPhoto(s.text)}]].`
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
  // The course's own « Add files » input is multiple too: pick only once the gallery has replaced it.
  await expect(page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible()
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

/** « Explain this photo » on the photo: it is read right below it. */
const explainWithAi = (page: Page) => page.getByRole('main').getByRole('button', { name: 'Explain this photo' })

/** What was read on the photo, below it. */
const readingOf = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Explain this photo' })

test('a photo is read below it from a reduced copy, its cost shown, then cited in a study sheet written from it', async ({
  page,
}) => {
  const sent = await mockProvider(page)
  await configureAi(page, LLM)
  await courseWithPhotos(page, 'Biochemistry', [LARGE])
  const title = await openFirstPhoto(page)
  expect(sent).toHaveLength(0)

  // Keyboard: the action runs from Enter, and focus lands on the result for VoiceOver.
  await explainWithAi(page).focus()
  await page.keyboard.press('Enter')
  const reading = readingOf(page)
  await expect(reading.getByText('Krebs cycle steps')).toBeVisible()
  await expect(reading.getByRole('heading', { name: 'Text on the photo' })).toBeVisible()
  await expect(reading.getByRole('table').getByRole('cell', { name: 'Citrate', exact: true })).toBeVisible()
  await expect(reading.getByText('The cycle oxidises acetyl-CoA to make NADH.')).toBeVisible()
  await expect(reading.getByRole('listitem').filter({ hasText: 'Citrate starts the cycle' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.textContent?.includes('Krebs cycle steps') ?? false))
    .toBe(true)
  await expect(reading.getByText(/Estimated cost: \$.* · Claude Haiku 5\.5/)).toBeVisible()
  await expect(reading.getByText('The photo is sent reduced to 1,024 px at most.')).toBeVisible()

  // One request, with the photo as an image no larger than 1024 px, turned into a JPEG.
  expect(sent).toHaveLength(1)
  const request = sent[0]
  expect(request?.images).toHaveLength(1)
  expect(jpegSize(request?.images[0] ?? '')).toEqual({ mime: 'image/jpeg', width: 1024, height: 512 })
  expect(request?.text).toContain('Course: Biochemistry')

  // What was read is kept: closed then asked again, it shows without a new request.
  await explainWithAi(page).click()
  await expect(reading).toHaveCount(0)
  await explainWithAi(page).click()
  await expect(reading.getByText('Krebs cycle steps')).toBeVisible()
  await expect(reading.getByRole('button', { name: 'Explain again' })).toBeVisible()
  expect(sent).toHaveLength(1)

  // A study sheet grounds in the photo and cites it: thumbnail and link back to the photo.
  await expect(reading.getByText('Kept on this device: study sheets can now use and cite this photo.')).toBeVisible()
  await reading.getByRole('button', { name: 'Write a study sheet' }).click()
  // Written on the sheet's own screen, on the photo's topic, from what was read on it.
  await expect(page).toHaveURL(/#\/fiche\//)
  const panel = page.getByRole('region', { name: 'Write with AI' })
  await expect(panel.getByText('Includes what AI read on 1 photo.')).toBeVisible()
  const fiche = page.getByRole('textbox', { name: 'Study sheet' })
  await expect(fiche.getByRole('heading', { name: 'Citrate' })).toBeVisible()
  expect(sent.at(-1)?.text).toContain('Topic: Krebs cycle steps\n')
  expect(sent.at(-1)?.text).toContain('| 1 | Citrate |')
  expect(sent.at(-1)?.images).toHaveLength(0)
  // The photo is cited by its name, the link opening it.
  await fiche.locator('.cm-md-link', { hasText: title }).click()
  const cite = page.getByRole('link', { name: 'Open the link' })
  await expect(cite).toHaveAttribute('href', /#\/photo\//)
  await cite.click()
  await expect(page).toHaveURL(/#\/photo\//)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
})

test('a photo with nothing written about it has nothing to summarise; once it has notes, the AI reads them', async ({
  page,
}, info) => {
  const sent = await mockProvider(page)
  await configureAi(page, LLM)
  await courseWithPhotos(page, 'Histology', [LARGE])
  await openFirstPhoto(page)
  const id = decodeURIComponent(/#\/photo\/([^/?]+)/.exec(page.url())?.[1] ?? '')
  expect(id).not.toBe('')
  await page.goto(`./#/source/${encodeURIComponent(id)}`)
  const main = page.getByRole('main')
  const chat = chatPanel(page, info.project.name)
  await main.getByRole('button', { name: 'Ask about this' }).first().click()
  await expect(chat.getByRole('textbox', { name: 'Your question' })).toBeVisible()
  await expect(chat.getByRole('button', { name: 'Summarise this source' })).toHaveCount(0)
  await restoreChat(page, info.project.name)
  if (isPhone(info.project.name)) await chat.getByRole('button', { name: 'Close chat' }).click()
  await expect(main.getByRole('button', { name: 'Summarise this source' })).toHaveCount(0)

  // Notes written on the photo: there is something to read now, and it is what the model is given.
  await page.getByRole('textbox', { name: 'Notes' }).click()
  await page.keyboard.type('Stratified squamous epithelium lines the oesophagus.')
  await main.getByRole('button', { name: 'Summarise this source' }).click()
  await expect.poll(() => sent.at(-1)?.text ?? '').toContain('Stratified squamous epithelium lines the oesophagus.')
  expect(sent.at(-1)?.text).toContain(`<<<SOURCE id="${id}">>>`)
  expect(sent).toHaveLength(1)
})

test('« Create cards » from a photo read: chosen in the sheet, they wait in Suggested cards, made from the photo', async ({
  page,
}) => {
  const sent = await mockProvider(page)
  await configureAi(page, LLM)
  await courseWithPhotos(page, 'Metabolism', [LARGE, LARGE])
  await openFirstPhoto(page)
  await explainWithAi(page).click()
  const reading = readingOf(page)
  await expect(reading.getByText('Krebs cycle steps')).toBeVisible()
  await reading.getByRole('button', { name: 'Create cards' }).click()
  const sheet = page.getByRole('dialog', { name: 'Create cards' })
  await sheet.getByRole('button', { name: 'Create cards' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Suggested cards' })).toBeVisible()
  await expect(page.getByText('What starts the Krebs cycle?')).toBeVisible()
  // One request for that photo, the photo sent with it; nothing is a card until added.
  const cards = sent.filter((s) => s.text.includes('flashcards from photos'))
  expect(cards).toHaveLength(1)
  expect(cards[0]?.images).toHaveLength(1)
})

test('a running reading can be stopped; offline, its actions wait for a connection', async ({ page, context }) => {
  let release: () => void = () => undefined
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const sent = await mockProvider(page, hold)
  await configureAi(page, LLM)
  await courseWithPhotos(page, 'Genetics', [LARGE])
  await openFirstPhoto(page)
  await explainWithAi(page).click()
  const reading = readingOf(page)

  await expect(reading.getByRole('status').filter({ hasText: 'Reading the photo…' })).toBeVisible()
  await expect.poll(() => sent.length).toBe(1)
  await reading.getByRole('button', { name: 'Stop' }).click()
  await expect(reading.getByText('Reading the photo…')).toHaveCount(0)
  await expect(reading.getByRole('button', { name: 'Explain again' })).toBeEnabled()
  release()
  await expect(reading.getByText('Krebs cycle steps')).toHaveCount(0)
  await expect(reading.getByRole('alert')).toHaveCount(0)

  await context.setOffline(true)
  await expect(reading.getByText('You’re offline. Explanations need a connection.')).toBeVisible()
  await expect(reading.getByRole('button', { name: 'Explain again' })).toBeDisabled()
  await expect(reading.getByRole('button', { name: 'Create cards' })).toBeDisabled()
  await context.setOffline(false)
  await expect(reading.getByRole('button', { name: 'Explain again' })).toBeEnabled()

  // Read, its « Create cards » waits for a connection too.
  await reading.getByRole('button', { name: 'Explain again' }).click()
  await expect(reading.getByText('Krebs cycle steps')).toBeVisible()
  await expect(reading.getByRole('button', { name: 'Create cards' })).toBeEnabled()
  await context.setOffline(true)
  await expect(reading.getByRole('button', { name: 'Create cards' })).toBeDisabled()
  await context.setOffline(false)
  await expect(reading.getByRole('button', { name: 'Create cards' })).toBeEnabled()
})

test('without a model nothing of the AI shows; with one that reads no images, the reading links to the AI settings', async ({
  page,
}, info) => {
  await courseWithPhotos(page, 'Anatomy', [LARGE])
  const photoUrl = await (async () => {
    await openFirstPhoto(page)
    return page.url()
  })()
  const chat = chatPanel(page, info.project.name)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: 'New card with this photo' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Explain this photo' })).toHaveCount(0)
  await expect(chat).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Ask about this' })).toHaveCount(0)

  // A text-only model: the reading says so and leads to the settings.
  await page.goto('./#/settings/ai')
  await openModels(page)
  await aiSearch(page).fill('302 deepseek v3.2')
  const row = providerGroup(page, '302.AI').getByRole('button', { name: /^deepseek-v3\.2 deepseek-v3\.2/ })
  await row.click()
  await page.getByLabel('API key').fill('sk-test-123')
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect(providerPicker(page)).toHaveValue('302ai')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved on this device.')).toBeVisible()

  await page.goto(photoUrl)
  await explainWithAi(page).click()
  const reading = readingOf(page)
  await expect(
    reading.getByText(
      'deepseek-v3.2 reads text only. To explain photos, choose a model that reads images in the AI settings.',
    ),
  ).toBeVisible()
  await reading.getByRole('link', { name: 'Open AI settings' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible()
})

test('a course whose only source is a photo: the chat never says there is none, sends it before it is read, then cites its reading', async ({
  page,
}, info) => {
  const sent = await mockProvider(page)
  await configureAi(page, LLM)
  const courseId = await courseWithPhotos(page, 'Biochemistry', [LARGE])
  const course = `./#/course/${encodeURIComponent(courseId)}`
  const chat = chatPanel(page, info.project.name)
  const openChat = async () => {
    if (!(await chat.isVisible()))
      await page.getByRole('main').getByRole('button', { name: 'Ask about this' }).first().click()
    await expect(chat.getByRole('textbox', { name: 'Your question' })).toBeVisible()
  }
  const askChat = async (question: string) => {
    await chat.getByRole('textbox', { name: 'Your question' }).fill(question)
    await chat.getByRole('button', { name: 'Send', exact: true }).click()
  }

  // Nothing read on it yet: the photo goes along with the question, reduced, and the answer cites it.
  await page.goto(course)
  await openChat()
  await askChat('What starts the cycle?')
  await expect(chat.getByText('Citrate starts the cycle')).toBeVisible()
  expect(sent).toHaveLength(1)
  expect(sent[0]?.text).not.toContain('No sources are available')
  expect(sent[0]?.images).toHaveLength(1)
  expect(jpegSize(sent[0]?.images[0] ?? '')).toEqual({ mime: 'image/jpeg', width: 1024, height: 512 })
  await expect(chat.getByRole('link', { name: /^Open photo: / })).toHaveCount(1)
  await expect(chat).not.toContainText(/no source/i)

  // Read on its own screen meanwhile: the chat, still open, grounds in the reading at once, no image sent.
  await restoreChat(page, info.project.name)
  if (isPhone(info.project.name)) await chat.getByRole('button', { name: 'Close chat' }).click()
  await page.goto(`${course}/photos`)
  await openFirstPhoto(page)
  await explainWithAi(page).click()
  await expect(readingOf(page).getByText('Krebs cycle steps')).toBeVisible()
  expect(sent).toHaveLength(2)
  await page.goto(course)
  await openChat()
  await chat.getByRole('button', { name: 'New chat' }).click()
  await askChat('And then?')
  await expect(chat.getByText('Citrate starts the cycle')).toBeVisible()
  expect(sent).toHaveLength(3)
  expect(sent[2]?.images).toHaveLength(0)
  expect(sent[2]?.text).toMatch(/<<<SOURCE id="[^"]+">>>\nKrebs cycle steps/)
  expect(sent[2]?.text).not.toContain('No sources are available')
  await expect(chat.getByRole('link', { name: /^Open photo: / })).toHaveCount(1)
})
