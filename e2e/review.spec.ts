import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { expect, type Page, type Route, test } from '@playwright/test'

// Review needs cards with a history. Instead of a test path in the app, a throwaway harness
// (bundled like p2p.spec.ts) opens the same local log on the app's origin and writes through
// the Workspace, exactly as the app does: capture into the log, then seal.
const ROOT = resolve(import.meta.dirname, '..')
const HARNESS_BASE = '/cursus/__review-harness__/'
const ENTRY_ID = 'virtual:review-harness'
const ENTRY_CODE = `
import * as Y from 'yjs'
import { idbStore } from '${ROOT}/src/core/storage/idbStore.ts'
import { secretsVault } from '${ROOT}/src/core/storage/secrets.ts'
import { createLocalLog } from '${ROOT}/src/core/log/localLog.ts'
import { captureUpdates, REPLAY } from '${ROOT}/src/core/log/origins.ts'
import { createWorkspace } from '${ROOT}/src/core/model/workspace.ts'
import { systemClock } from '${ROOT}/src/core/ports/clock.ts'
import { defaultLocks } from '${ROOT}/src/core/ports/locks.ts'
import { cryptoRng } from '${ROOT}/src/core/ports/rng.ts'

async function seed(spec) {
  const store = idbStore()
  const clock = systemClock
  const rng = cryptoRng(clock)
  const log = createLocalLog({ store, locks: defaultLocks(), clock, rng })
  const { updates } = await log.load()
  const doc = new Y.Doc()
  for (const u of updates) Y.applyUpdateV2(doc, u, REPLAY)
  const ws = createWorkspace(doc, { rng, clock, deviceId: await log.deviceId() })
  const capture = captureUpdates(doc, (u) => log.appendLocal(u))
  const courseId = ws.courses.create({ title: spec.course, language: 'en' })
  for (const c of spec.cards) {
    const id = ws.batch(() => {
      const id = ws.cards.create({ courseId, kind: 'basic' })
      ws.text({ id, field: 'front' }).insert(0, c.front)
      ws.text({ id, field: 'back' }).insert(0, c.back)
      return id
    })
    for (const r of c.reviews ?? []) ws.reviews.record({ cardId: id, rating: r.rating, at: r.at, ms: 4000 })
  }
  await capture.settled()
  await log.seal()
  capture.stop()
  if (spec.ai) {
    const vault = secretsVault(store)
    await vault.set('ai-config', { providerId: 'ai21', modelId: 'jamba-mini', language: 'auto' })
    await vault.set('ai-key-ai21', 'test-key')
  }
  // The iOS install hint was already dismissed on this device.
  await store.commit([{ put: 'kv', key: 'pwa:install-hint-dismissed', value: true }])
  store.close()
}
window.harness = { seed }
`
const MIME: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' }

let outDir = ''
let entryFile = ''

test.use({ serviceWorkers: 'block' })

test.beforeAll(async () => {
  test.setTimeout(120_000)
  const { build } = await import('vite')
  outDir = await mkdtemp(join(tmpdir(), 'cursus-review-'))
  const result = await build({
    configFile: false,
    root: ROOT,
    base: HARNESS_BASE,
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true, target: 'es2022', minify: false, rollupOptions: { input: ENTRY_ID } },
    plugins: [
      {
        name: 'review-harness',
        resolveId: (id) => (id === ENTRY_ID ? `\0${ENTRY_ID}` : null),
        load: (id) => (id === `\0${ENTRY_ID}` ? ENTRY_CODE : null),
      },
    ],
  })
  for (const output of [result].flat()) {
    if (!('output' in output)) continue
    for (const file of output.output) if (file.type === 'chunk' && file.isEntry) entryFile = file.fileName
  }
  expect(entryFile).not.toBe('')
})

test.afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true })
})

interface SeedCard {
  front: string
  back: string
  reviews?: { rating: 1 | 2 | 3 | 4; at: number }[]
}
interface SeedSpec {
  course: string
  cards: SeedCard[]
  ai?: boolean
}

async function seed(page: Page, spec: SeedSpec): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith(HARNESS_BASE),
    async (route) => {
      const path = new URL(route.request().url()).pathname.slice(HARNESS_BASE.length)
      if (path === '' || path === 'index.html') {
        const html = `<!doctype html><meta charset="utf-8"><title>harness</title><script type="module" src="${HARNESS_BASE}${entryFile}"></script>`
        return route.fulfill({ status: 200, contentType: 'text/html', body: html })
      }
      try {
        const body = await readFile(join(outDir, path))
        return route.fulfill({ status: 200, contentType: MIME[extname(path)] ?? 'application/octet-stream', body })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return route.fulfill({ status: 404, body: 'not found' })
      }
    },
  )
  await page.goto(HARNESS_BASE)
  await page.waitForFunction(() => 'harness' in window)
  await page.evaluate(
    (s) => (window as unknown as { harness: { seed(s: unknown): Promise<void> } }).harness.seed(s),
    spec,
  )
}

const DAY = 86_400_000

/** A card that lapsed eight times, long enough ago to be due today. */
function leechHistory(now: number): SeedCard['reviews'] {
  const start = now - 400 * DAY
  const reviews: NonNullable<SeedCard['reviews']> = [{ rating: 4, at: start }]
  for (let i = 1; i <= 8; i++) {
    reviews.push({ rating: 1, at: start + i * 10 * DAY })
    reviews.push({ rating: 3, at: start + i * 10 * DAY + 600_000 })
  }
  return reviews
}

/** Stands in for the AI provider: answers by feature, in the chat-completions format. */
async function fakeProvider(page: Page): Promise<string[]> {
  const features: string[] = []
  await page.route('https://api.ai21.com/**', async (route: Route) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
    }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const body = route.request().postData() ?? ''
    let content: unknown
    if (body.includes('Grade a student answer')) {
      features.push('gradeAnswer')
      content = { suggestedRating: 4, correct: true, feedback: 'Spot on: that is the powerhouse of the cell.' }
    } else if (body.includes('wants to understand the answer')) {
      features.push('explainCard')
      content = { explanation: 'Mitochondria turn nutrients into ATP.', mnemonic: 'Mighty mitochondria' }
    } else if (body.includes('Improve a spaced-repetition flashcard')) {
      features.push('improveCard')
      content = { front: 'Capital city of Australia?', back: 'Canberra', rationale: 'One clear question.' }
    } else {
      return route.fulfill({ status: 400, headers: cors, body: 'unexpected request' })
    }
    return route.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'cmpl-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'jamba-mini',
        choices: [
          { index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      }),
    })
  })
  return features
}

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

const isPhone = (name: string) => name === 'webkit-iphone'

async function openReview(page: Page) {
  await page.goto('./#/review')
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible()
}

/** Reveals with Space on a keyboard device, with a tap on a phone. */
async function reveal(page: Page, phone: boolean) {
  if (phone) await page.getByRole('button', { name: /Show answer/ }).tap()
  else await page.keyboard.press('Space')
  await expect(page.getByTestId('answer')).toBeVisible()
}

test('focus mode: reveal, grade with predicted intervals, undo, then settle into All caught up', async ({
  page,
}, info) => {
  const phone = isPhone(info.project.name)
  const errors = watchErrors(page)
  await seed(page, {
    course: 'Biology',
    cards: [
      { front: 'Powerhouse of the cell?', back: 'The mitochondrion' },
      { front: 'Site of photosynthesis?', back: 'The chloroplast' },
      { front: 'Carrier of genetic code?', back: 'DNA' },
    ],
  })
  await openReview(page)
  await expect(page.getByRole('progressbar', { name: '0 of 3' })).toBeVisible()
  const first = page.getByText(/\?$/).first()
  const question = await first.textContent()
  await expect(page.getByRole('button', { name: /Again/ })).toHaveCount(0)

  await reveal(page, phone)
  // Each grade carries the interval it would schedule; new cards: minutes for Again, days for Easy.
  await expect(page.getByRole('button', { name: /^Again, next review in .*min/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Easy, next review in .*day/ })).toBeVisible()
  if (phone) await page.getByRole('button', { name: /^Good, next review in/ }).tap()
  else await page.keyboard.press('3')
  await expect(page.getByRole('progressbar', { name: '1 of 3' })).toBeVisible()
  await expect(page.getByText(question ?? '', { exact: true })).toHaveCount(0)

  // Undo brings the same card back, revealed, and voids the review.
  if (phone) await page.getByRole('button', { name: 'Undo last answer' }).tap()
  else await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect(page.getByText('Answer undone')).toBeVisible()
  await expect(page.getByRole('progressbar', { name: '0 of 3' })).toBeVisible()
  await expect(page.getByText(question ?? '', { exact: true })).toBeVisible()
  await expect(page.getByTestId('answer')).toBeVisible()

  for (let i = 0; i < 3; i++) {
    if (i > 0) {
      await expect(page.getByRole('progressbar', { name: `${i} of 3` })).toBeVisible()
      await reveal(page, phone)
    }
    await page.getByRole('button', { name: /^Good, next review in/ }).click()
  }
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('You reviewed 3 cards.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible()
  await expect(page.getByText(/due tomorrow|Nothing is due tomorrow/)).toBeVisible()

  // The answers were recorded: coming back, the queue is empty.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to Today' }).click()
  await expect(page).toHaveURL(/#\/$/)
  expect(errors).toEqual([])
})

test('without AI, "Answer in your own words" leads to the AI settings', async ({ page }) => {
  await seed(page, { course: 'Geography', cards: [{ front: 'Longest river?', back: 'The Nile' }] })
  await openReview(page)
  await page.getByRole('link', { name: 'Set up AI to check answers in your own words' }).click()
  await expect(page).toHaveURL(/#\/settings\/ai$/)
})

test('own words: the AI suggests a grade to confirm; Why? explains and makes a card', async ({ page }, info) => {
  const phone = isPhone(info.project.name)
  const errors = watchErrors(page)
  const features = await fakeProvider(page)
  await seed(page, {
    course: 'Biology',
    ai: true,
    cards: [
      { front: 'Powerhouse of the cell?', back: 'The mitochondrion' },
      { front: 'Site of photosynthesis?', back: 'The chloroplast' },
    ],
  })
  await openReview(page)
  await page.getByRole('button', { name: 'Answer in your own words' }).click()
  const answer = page.getByRole('textbox', { name: 'Your answer' })
  await expect(answer).toBeFocused()
  const front = await page.getByText(/\?$/).first().textContent()
  await answer.fill('the mitochondria, where energy is made')
  await page.getByRole('button', { name: 'Check' }).click()

  await expect(page.getByText('Suggested grade: Easy')).toBeVisible()
  await expect(page.getByText(/Spot on/)).toBeVisible()
  const easy = page.getByRole('button', { name: /^Easy, next review in/ })
  await expect(easy).toHaveAttribute('data-suggested', 'true')
  if (!phone) await expect(easy).toBeFocused()

  await page.getByRole('button', { name: 'Why?' }).click()
  await expect(page.getByText('Mitochondria turn nutrients into ATP.')).toBeVisible()
  await expect(page.getByText('Mighty mitochondria')).toBeVisible()
  await page.getByRole('button', { name: 'Create a card on this point' }).click()
  await expect(page.getByText('Card added to Biology')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create a card on this point' })).toBeDisabled()

  await easy.click()
  await expect(page.getByRole('progressbar', { name: '1 of 2' })).toBeVisible()
  await expect(page.getByText(front ?? '', { exact: true })).toHaveCount(0)
  expect(features).toEqual(['gradeAnswer', 'explainCard'])
  expect(errors).toEqual([])
})

test('a leech shows its badge and can be rewritten with Improve', async ({ page }) => {
  const errors = watchErrors(page)
  const features = await fakeProvider(page)
  await seed(page, {
    course: 'Geography',
    ai: true,
    cards: [
      { front: 'Australia capital (not Sydney!!) city name?', back: 'Canberra', reviews: leechHistory(Date.now()) },
    ],
  })
  await openReview(page)
  await expect(page.getByText('Leech', { exact: true })).toBeVisible()
  await expect(page.getByText('This card keeps slipping. Try rewriting it.')).toBeVisible()
  await page.getByRole('button', { name: 'Improve' }).click()
  await expect(page.getByRole('heading', { name: 'Suggested rewrite' })).toBeVisible()
  await expect(page.getByText('One clear question.')).toBeVisible()
  await page.getByRole('button', { name: 'Use this version' }).click()
  await expect(page.getByText('Card rewritten')).toBeVisible()
  await expect(page.getByText('Capital city of Australia?', { exact: true })).toBeVisible()
  await expect(page.getByText('Australia capital (not Sydney!!) city name?')).toHaveCount(0)
  expect(features).toEqual(['improveCard'])
  expect(errors).toEqual([])
})

test('read aloud uses the course language', async ({ page }) => {
  await page.addInitScript(() => {
    const spoken: { text: string; lang: string }[] = []
    // A recording synthesizer: headless browsers have no voices to play.
    class Utterance {
      text: string
      lang = ''
      voice = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(text: string) {
        this.text = text
      }
    }
    const synth = {
      speak: (u: Utterance) => spoken.push({ text: u.text, lang: u.lang }),
      cancel: () => {},
      getVoices: () => [],
    }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance })
    Object.assign(window, { spoken })
  })
  await seed(page, { course: 'Biology', cards: [{ front: 'Powerhouse of the **cell**?', back: 'The mitochondrion' }] })
  await openReview(page)
  await page.getByRole('button', { name: 'Read the question aloud' }).click()
  const spoken = await page.evaluate(() => (window as unknown as { spoken: { text: string; lang: string }[] }).spoken)
  expect(spoken).toEqual([{ text: 'Powerhouse of the cell?', lang: 'en' }])
})

test('with nothing due, the view is already caught up', async ({ page }) => {
  await page.goto('./#/review')
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible()
  await expect(page.getByText(/due tomorrow|Nothing is due tomorrow/)).toBeVisible()
})
