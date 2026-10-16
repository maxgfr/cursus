import { expect, type Page, test } from '@playwright/test'
import { chatPanel, configureAi } from './support/ai'
import { createHarness } from './support/harness.ts'
import { isPhone, seriousViolations, watchErrors } from './support/page.ts'

// The chat is as wide as the student makes it: its left edge is dragged (or moved with the keyboard), the page
// beside it narrows, and the width is kept on this device. On a phone the chat takes the whole screen.

test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

async function openChatOnCourse(page: Page, project: string) {
  await page.goto('./#/courses')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Biology/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Biology' })).toBeVisible()
  const panel = chatPanel(page, project)
  // The chat may already be open (it stays so across screens): opened only if it is not.
  const ask = page.getByRole('button', { name: 'Ask about this' }).first()
  await expect(ask).toBeVisible()
  if ((await ask.getAttribute('aria-pressed')) !== 'true') await ask.click()
  await expect(panel).toBeVisible()
  return panel
}

const width = async (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => Math.round(el.getBoundingClientRect().width))

test('dragging the chat’s edge widens it and narrows the page; kept after a reload; keys move it too', async ({
  page,
}, info) => {
  test.skip(isPhone(info.project.name), 'on a phone the chat takes the whole screen')
  const errors = watchErrors(page)
  await harness.seed(page, { courses: [{ title: 'Biology', notes: [{ title: 'Cells', body: 'A cell.' }] }] })
  await configureAi(page, 'https://llm.mock.test/v1')
  const panel = await openChatOnCourse(page, info.project.name)
  const edge = page.getByRole('separator', { name: 'Chat width' })
  await expect(edge).toBeVisible()
  const before = Number(await edge.getAttribute('aria-valuenow'))
  const panelBefore = Math.round((await panel.boundingBox())?.width ?? 0)
  const mainBefore = await width(page, 'main')

  const box = await edge.boundingBox()
  if (!box) throw new Error('no edge')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 4 })
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  // As far as dragged, unless the page would be left too narrow (a tablet): then as wide as it may be.
  const widest = Number(await edge.getAttribute('aria-valuemax'))
  const wider = Math.min(before + 120, widest)
  const gained = wider - before
  await expect.poll(async () => Number(await edge.getAttribute('aria-valuenow'))).toBe(wider)
  const docked = await page.evaluate(() => innerWidth >= 1000)
  await expect
    .poll(async () => Math.round((await panel.boundingBox())?.width ?? 0))
    .toBeGreaterThanOrEqual(panelBefore + gained - 2)
  if (docked) expect(await width(page, 'main')).toBeLessThanOrEqual(mainBefore - gained + 2)

  // Remembered on this device.
  await page.reload()
  const again = await openChatOnCourse(page, info.project.name)
  await expect(page.getByRole('separator', { name: 'Chat width' })).toHaveAttribute('aria-valuenow', String(wider))
  await expect
    .poll(async () => Math.round((await again.boundingBox())?.width ?? 0))
    .toBeGreaterThanOrEqual(panelBefore + gained - 2)

  // The keyboard: → narrows by a step, Home and End go to its narrowest and widest, a double click resets it.
  const handle = page.getByRole('separator', { name: 'Chat width' })
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', String(wider - 16))
  await page.keyboard.press('Home')
  await expect(handle).toHaveAttribute('aria-valuenow', (await handle.getAttribute('aria-valuemin')) ?? '')
  await page.keyboard.press('End')
  await expect(handle).toHaveAttribute('aria-valuenow', (await handle.getAttribute('aria-valuemax')) ?? '')
  await handle.dblclick()
  await expect(handle).toHaveAttribute('aria-valuenow', String(before))
  expect(await seriousViolations(page)).toEqual([])
  expect(errors).toEqual([])
})

test('on a phone the chat takes the whole screen, with no edge to drag', async ({ page }, info) => {
  test.skip(!isPhone(info.project.name), 'phones only')
  await harness.seed(page, { courses: [{ title: 'Biology', notes: [{ title: 'Cells', body: 'A cell.' }] }] })
  await configureAi(page, 'https://llm.mock.test/v1')
  const panel = await openChatOnCourse(page, info.project.name)
  const viewport = page.viewportSize()?.width ?? 0
  expect(Math.round((await panel.boundingBox())?.width ?? 0)).toBe(viewport)
  await expect(page.getByRole('separator', { name: 'Chat width' })).toBeHidden()
})
