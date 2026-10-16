import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { expect, type Page, type Route, test } from '@playwright/test'
import { completionReply } from './support/ai.ts'
import { seriousViolations } from './support/page.ts'

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
  await store.commit([{ put: 'kv', key: 'pwa:install-hint-dismissed', value: Date.now() }])
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
    } else if (body.includes('asks why it is the answer')) {
      features.push('explainCard')
      content = { explanation: 'Mitochondria turn nutrients into ATP.', mnemonic: 'Mighty mitochondria' }
    } else if (body.includes('Improve a spaced-repetition flashcard')) {
      features.push('improveCard')
      content = { front: 'Capital city of Australia?', back: 'Canberra', rationale: 'One clear question.' }
    } else {
      return route.fulfill({ status: 400, headers: cors, body: 'unexpected request' })
    }
    // Streamed when the screen shows the answer as it is written.
    return route.fulfill(completionReply(route.request(), JSON.stringify(content), cors, 'jamba-mini'))
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
  // One progress readout: "3 left", announced politely; no ring, no "0/3".
  await expect(page.getByTestId('remaining')).toHaveText('3 left')
  await expect(page.getByTestId('remaining')).toHaveAttribute('role', 'status')
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  await expect(page.getByText('0/3', { exact: true })).toHaveCount(0)
  // No uppercase eyebrows over the faces: the regions are named for assistive tech instead.
  await expect(page.getByRole('heading', { name: 'Question' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Question' })).toBeVisible()
  const first = page.getByText(/\?$/).first()
  const question = await first.textContent()
  await expect(page.getByRole('button', { name: /Again/ })).toHaveCount(0)

  // The hidden answer is the card's back face: a filled surface, not a dashed drop zone.
  const showAnswer = page.getByRole('button', { name: /Show answer/ })
  expect(await showAnswer.evaluate((el) => getComputedStyle(el).borderStyle)).not.toContain('dashed')
  const before = await showAnswer.boundingBox()
  await reveal(page, phone)
  // Measured once the turn has settled.
  await page.getByTestId('answer').evaluate((el) => {
    for (const a of el.getAnimations()) a.finish()
  })
  const after = await page.getByTestId('answer').boundingBox()
  // The answer turns up in the same footprint.
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 1))).toBeLessThan(2)
  expect(Math.abs((after?.width ?? 0) - (before?.width ?? 1))).toBeLessThan(2)
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 1))).toBeLessThan(2)
  // Each grade carries the interval it would schedule; new cards: minutes for Again, days for Easy.
  await expect(page.getByRole('button', { name: /^Again, next review in .*min/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Easy, next review in .*day/ })).toBeVisible()
  if (phone) await page.getByRole('button', { name: /^Good, next review in/ }).tap()
  else {
    // Focus lands on the grades group, not on Again; Space a second time gives Good.
    await expect(page.getByTestId('grades')).toBeFocused()
    await expect(page.getByRole('button', { name: /^Again, next review in/ })).not.toBeFocused()
    await page.keyboard.press('Space')
  }
  await expect(page.getByTestId('remaining')).toHaveText('2 left')
  await expect(page.getByText(question ?? '', { exact: true })).toHaveCount(0)

  // Undo brings the same card back, revealed, and voids the review.
  if (phone) await page.getByRole('button', { name: 'Undo last answer' }).tap()
  else await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect(page.getByText('Answer undone')).toBeVisible()
  await expect(page.getByTestId('remaining')).toHaveText('3 left')
  await expect(page.getByText(question ?? '', { exact: true })).toBeVisible()
  await expect(page.getByTestId('answer')).toBeVisible()

  for (let i = 0; i < 3; i++) {
    if (i > 0) {
      await expect(page.getByTestId('remaining')).toHaveText(`${3 - i} left`)
      await reveal(page, phone)
    }
    // Easy graduates a new card; Good would bring it back in 10 minutes.
    await page.getByRole('button', { name: /^Easy, next review in/ }).click()
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

test('without AI, the focus view offers no "own words" link (setup lives in Understand and Settings)', async ({
  page,
}, info) => {
  const phone = isPhone(info.project.name)
  await seed(page, { course: 'Geography', cards: [{ front: 'Longest river?', back: 'The Nile' }] })
  await openReview(page)
  await expect(page.getByRole('button', { name: /Show answer/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Set up AI/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Answer in your own words' })).toHaveCount(0)
  // One keycap style: Show answer's hint and the grades' keys share the same class.
  const revealCap = await page
    .getByRole('button', { name: /Show answer/ })
    .locator('kbd')
    .evaluate((k) => k.parentElement?.className ?? '')
  // The grades show their keys where a keyboard is likely, as Start and Show answer do.
  await reveal(page, phone)
  const gradeCap = await page
    .getByTestId('grades')
    .locator('kbd')
    .first()
    .evaluate((k) => k.parentElement?.className ?? '')
  expect(gradeCap.split(' ')[0]).toBe(revealCap.split(' ')[0])
  const keycap = page.getByTestId('grades').locator('kbd')
  const keyboard = await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)
  if (keyboard) {
    await expect(keycap).toHaveText(['1', '2', '3', '4'])
    // Inline after the label, on its line, not a badge in the corner.
    const easy = page.getByRole('button', { name: /^Easy, next review in/ })
    const name = await easy.getByText('Easy').boundingBox()
    const key = await easy.locator('kbd').boundingBox()
    if (!name || !key) throw new Error('missing box')
    expect(key.x).toBeGreaterThan(name.x + name.width / 2)
    expect(Math.abs(key.y + key.height / 2 - (name.y + name.height / 2))).toBeLessThan(6)
  } else await expect(keycap.first()).toBeHidden()
  // A one-line answer sits in the middle of the shared footprint, not pinned above an empty band.
  const box = await page.getByTestId('answer').boundingBox()
  const text = await page.getByTestId('answer').getByText('The Nile').boundingBox()
  if (!box || !text) throw new Error('missing box')
  expect(Math.abs(text.y + text.height / 2 - (box.y + box.height / 2))).toBeLessThan(8)
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
  // Answered below the card: typed there, graded, the grade offered on the card's buttons.
  await page.getByRole('button', { name: 'Answer in your own words' }).click()
  const own = page.getByRole('main').getByRole('region', { name: 'Answer in your own words' })
  const answer = own.getByRole('textbox', { name: 'Your answer' })
  const front = await page.getByTestId('question').getByText(/\?$/).first().textContent()
  await answer.fill('the mitochondria, where energy is made')
  await own.getByRole('button', { name: 'Check' }).click()

  await expect(page.getByRole('main').getByText('Suggested grade: Easy')).toBeVisible()
  await expect(page.getByRole('main').getByText(/Spot on/)).toBeVisible()
  const easy = page.getByRole('button', { name: /^Easy, next review in/ })
  await expect(easy).toHaveAttribute('data-suggested', 'true')
  // Suggested, not preselected: focus is on the grades group.
  if (!phone) await expect(page.getByTestId('grades')).toBeFocused()

  // « Why? » answers below the card, like « Explain the question », grounded and streamed.
  await page.getByRole('main').getByRole('button', { name: 'Why?' }).click()
  const why = page.getByRole('main').getByRole('region', { name: 'Why?' })
  await expect(why.getByText('Mitochondria turn nutrients into ATP.')).toBeVisible()
  await expect(why.getByText('Mighty mitochondria')).toBeVisible()
  await why.getByRole('button', { name: 'Create a card on this point' }).click()
  await expect(why.getByText('Added to Suggested cards')).toBeVisible()
  await expect(why.getByRole('button', { name: 'Create a card on this point' })).toBeDisabled()

  await easy.click()
  await expect(page.getByTestId('remaining')).toHaveText('1 left')
  await expect(page.getByText(front ?? '', { exact: true })).toHaveCount(0)
  expect(features).toEqual(['gradeAnswer', 'explainCard'])
  expect(errors).toEqual([])
})

test('own words below the card: the question stays in sight, and the grade suggested is confirmed on the card', async ({
  page,
}) => {
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
  const front = (await page.getByTestId('question').getByText(/\?$/).first().textContent()) ?? ''
  await page.getByRole('button', { name: 'Answer in your own words' }).click()
  const own = page.getByRole('main').getByRole('region', { name: 'Answer in your own words' })
  const box = own.getByRole('textbox', { name: 'Your answer' })
  // The question being answered stays in sight above the answer box.
  await box.focus()
  await expect(page.getByTestId('question')).toBeInViewport()
  await expect(box).toBeInViewport()
  await box.fill('the mitochondria, where energy is made')
  await own.getByRole('button', { name: 'Check' }).click()
  await expect(page.getByRole('main').getByText('Suggested grade: Easy')).toBeVisible()

  // Confirmed on the card: Easy, and the next card shows.
  const easy = page.getByRole('button', { name: /^Easy, next review in/ })
  await expect(easy).toHaveAttribute('data-suggested', 'true')
  await easy.click()
  await expect(page.getByTestId('remaining')).toHaveText('1 left')
  await expect(page.getByTestId('question')).not.toContainText(front)
  expect(features).toEqual(['gradeAnswer'])
  expect(errors).toEqual([])
})

test('a leech shows its badge and can be rewritten with Improve, then undone', async ({ page }) => {
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
  await expect(page.getByText('Hard card', { exact: true })).toBeVisible()
  await expect(page.getByText('This card keeps slipping. Try rewriting it.')).toBeVisible()
  await page.getByRole('button', { name: 'Improve' }).click()
  const sheet = page.getByRole('dialog', { name: 'Suggested rewrite' })
  await expect(sheet.getByText('One clear question.')).toBeVisible()
  // The card's answer is not shown yet: the proposed one waits folded.
  await expect(sheet.getByText('Canberra')).toBeHidden()
  await sheet.getByText('Show the proposed answer').click()
  await expect(sheet.getByText('Canberra', { exact: true })).toBeVisible()
  await sheet.getByRole('button', { name: 'Use this version' }).click()
  await expect(page.getByText('Card rewritten')).toBeVisible()
  await expect(page.getByTestId('question').getByText('Capital city of Australia?', { exact: true })).toBeVisible()
  await expect(page.getByText('Australia capital (not Sydney!!) city name?')).toHaveCount(0)
  // One undo puts both faces back.
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByTestId('question').getByText('Australia capital (not Sydney!!) city name?')).toBeVisible()
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

test('a card graded Again comes back in the same session; until then the session waits', async ({ page }, info) => {
  const phone = isPhone(info.project.name)
  const errors = watchErrors(page)
  await page.clock.install()
  await seed(page, { course: 'Biology', cards: [{ front: 'Powerhouse of the cell?', back: 'The mitochondrion' }] })
  await openReview(page)
  // The one progress readout is visible from the start.
  await expect(page.getByTestId('remaining')).toHaveText('1 left')
  // The card's back face, hidden and shown, passes axe in both themes.
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    expect(await seriousViolations(page)).toEqual([])
  }
  await reveal(page, phone)
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme })
    expect(await seriousViolations(page)).toEqual([])
  }
  await page.getByRole('button', { name: /^Again, next review in/ }).click()
  // Not "All caught up": the card is back in a minute, with a live countdown.
  await expect(page.getByRole('heading', { name: /^1 card back in 1 min/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'All caught up' })).toHaveCount(0)
  await expect(page.getByText(/^Next card in 0:\d\d$/)).toBeVisible()
  await page.clock.fastForward('01:05')
  await expect(page.getByText('Powerhouse of the cell?', { exact: true })).toBeVisible()
  await expect(page.getByTestId('remaining')).toHaveText('1 left')
  await reveal(page, phone)
  await expect(page.getByRole('button', { name: /^Easy, next review in/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('the summary counts cards, not answers: Again then Easy on one card is one card', async ({ page }, info) => {
  const phone = isPhone(info.project.name)
  const errors = watchErrors(page)
  await page.clock.install()
  await seed(page, { course: 'Biology', cards: [{ front: 'Powerhouse of the cell?', back: 'The mitochondrion' }] })
  await openReview(page)
  await reveal(page, phone)
  await page.getByRole('button', { name: /^Again, next review in/ }).click()
  await page.clock.fastForward('01:05')
  await expect(page.getByText('Powerhouse of the cell?', { exact: true })).toBeVisible()
  await reveal(page, phone)
  await page.getByRole('button', { name: /^Easy, next review in/ }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('You reviewed 1 card.')).toBeVisible()
  expect(errors).toEqual([])
})

test('undoing the Again that brought a card back removes its return from the queue', async ({ page }, info) => {
  const phone = isPhone(info.project.name)
  const errors = watchErrors(page)
  await page.clock.install()
  await seed(page, { course: 'Biology', cards: [{ front: 'Powerhouse of the cell?', back: 'The mitochondrion' }] })
  await openReview(page)
  await reveal(page, phone)
  await page.getByRole('button', { name: /^Again, next review in/ }).click()
  await page.clock.fastForward('01:05')
  await expect(page.getByText('Powerhouse of the cell?', { exact: true })).toBeVisible()
  // Undo the Again: the card is back as it was before, once.
  if (phone) await page.getByRole('button', { name: 'Undo last answer' }).tap()
  else await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect(page.getByTestId('answer')).toBeVisible()
  await expect(page.getByTestId('remaining')).toHaveText('1 left')
  await page.getByRole('button', { name: /^Easy, next review in/ }).click()
  // Not shown a second time: the session is complete with one answer.
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('You reviewed 1 card.')).toBeVisible()
  expect(errors).toEqual([])
})

test('Space pressed the moment the card paints reveals it', async ({ page }) => {
  const errors = watchErrors(page)
  await seed(page, { course: 'Biology', cards: [{ front: 'Powerhouse of the cell?', back: 'The mitochondrion' }] })
  // The press lands as soon as the card's reveal button is in the document, before anything run after the paint.
  await page.addInitScript(() => {
    let pressed = false
    const observer = new MutationObserver(() => {
      if (pressed) return
      const shown = [...document.querySelectorAll('button')].some((b) => /Show answer/.test(b.textContent ?? ''))
      if (!shown) return
      pressed = true
      observer.disconnect()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    })
    observer.observe(document, { childList: true, subtree: true })
  })
  await page.goto('./#/review')
  await expect(page.getByTestId('answer')).toBeVisible()
  expect(errors).toEqual([])
})

test('Esc leaves the review for where it was opened from', async ({ page }, info) => {
  test.skip(isPhone(info.project.name), 'no hardware keyboard on the phone')
  await seed(page, { course: 'Biology', cards: [{ front: 'Powerhouse of the cell?', back: 'The mitochondrion' }] })
  await page.goto('./#/')
  await expect(page.getByRole('heading', { name: '1 card due today' })).toBeVisible()
  // S starts from Today.
  await page.keyboard.press('s')
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
})

test('with nothing due, the view is already caught up', async ({ page }) => {
  await page.goto('./#/review')
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible()
  await expect(page.getByText(/due tomorrow|Nothing is due tomorrow/)).toBeVisible()
})
