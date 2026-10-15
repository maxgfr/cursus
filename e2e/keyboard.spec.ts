import { expect, type Page, test } from '@playwright/test'
import { createHarness } from './support/harness.ts'

// The on-screen keyboard, simulated: the visual viewport shrinks while the layout one keeps its height, as on
// iOS. Once it has risen, the caret is brought above it, wherever iOS left the page.
test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

const LONG = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long note about the cell.`).join('\n\n')

/** A visual viewport the test drives: `keyboard(px)` raises a keyboard that tall, `keyboard(0)` lowers it. */
async function fakeViewport(page: Page) {
  await page.addInitScript(() => {
    const target = new EventTarget()
    let inset = 0
    // Getters stay live (Object.assign would copy their values once).
    const vv = Object.defineProperties(target, {
      height: { get: () => window.innerHeight - inset },
      width: { get: () => window.innerWidth },
      offsetTop: { value: 0 },
      offsetLeft: { value: 0 },
      pageTop: { get: () => window.scrollY },
      pageLeft: { get: () => window.scrollX },
      scale: { value: 1 },
    })
    Object.defineProperty(window, 'visualViewport', { get: () => vv, configurable: true })
    Object.defineProperty(window, '__keyboard', {
      value: (px: number) => {
        inset = px
        target.dispatchEvent(new Event('resize'))
      },
    })
  })
}

const raise = (page: Page, px: number) =>
  page.evaluate((h) => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(h), px)

/** The caret's bottom edge in viewport pixels, and the top of the simulated keyboard. */
const caretAndKeyboard = (page: Page) =>
  page.evaluate(() => {
    const sel = document.getSelection()
    const r = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getClientRects() : null
    const rect = r && r.length > 0 ? r[r.length - 1] : null
    return { caret: rect ? rect.bottom : -1, keyboardTop: window.visualViewport?.height ?? 0 }
  })

test('once the keyboard has risen, the caret of a long note sits above it', async ({ page }) => {
  await fakeViewport(page)
  await harness.seed(page, { courses: [{ title: 'Biology', notes: [{ title: 'Cell notes', body: LONG }] }] })
  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .click()
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page
    .getByRole('main')
    .getByRole('link', { name: /Cell notes/ })
    .click()
  const editor = page.getByRole('textbox', { name: 'Source' })
  await expect(editor).toContainText('Line 1 ')

  // The caret at the end of the note, scrolled into view as a browser does, then the keyboard rises over it.
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await expect(editor).toContainText('Line 60')
  await page.evaluate(() => {
    const sel = document.getSelection()
    sel?.focusNode?.parentElement?.scrollIntoView({ block: 'end' })
  })
  const height = page.viewportSize()?.height ?? 800
  await raise(page, Math.round(height * 0.4))
  await expect
    .poll(async () => {
      const { caret, keyboardTop } = await caretAndKeyboard(page)
      return caret > 0 && caret <= keyboardTop
    })
    .toBe(true)
})
