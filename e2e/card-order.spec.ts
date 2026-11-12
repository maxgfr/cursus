import { expect, type Locator, type Page, test } from '@playwright/test'
import { createCourse, seriousViolations, watchErrors } from './support/page.ts'

test.use({ serviceWorkers: 'block' })

/** A course with four cards, in this order, opened on its cards. */
async function courseWithCards(page: Page): Promise<Locator> {
  await page.goto('./#/')
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await createCourse(page, 'Order')
  const course = page.url()
  await page.goto('./#/stats')
  await expect(page.getByRole('heading', { level: 1, name: 'Statistics' })).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import cards (CSV/TSV): Order' }).click()
  const csv = 'front,back\nAlpha,1\nBravo,2\nCharlie,3\nDelta,4\n'
  await (await chooser).setFiles({ name: 'cards.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await expect(page.getByRole('status').filter({ hasText: '4 cards imported' })).toBeVisible()
  await page.goto(course)
  await expect(page.getByRole('heading', { level: 1, name: 'Order' })).toBeVisible()
  await page.getByRole('radio', { name: 'Cards' }).check()
  return page.getByRole('region', { name: 'Cards' })
}

const fronts = (list: Locator) =>
  list
    .getByRole('listitem')
    .evaluateAll((rows) => rows.map((r) => r.textContent?.match(/Alpha|Bravo|Charlie|Delta/)?.[0]))

/** Presses the pointer on `from`, then drags it to `to`'s lower part, in small steps, and lets go. */
async function mouseDrag(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  if (!a || !b) throw new Error('not on screen')
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + a.width / 2, b.y + b.height * 0.85, { steps: 12 })
  await page.mouse.up()
}

/** A finger resting on `row` for `ms`, then (if `toY`) sliding to that viewport Y and lifting. */
async function touchHold(row: Locator, ms: number, toY?: number) {
  await row.evaluate(
    async (el, { ms, toY }) => {
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const at = (type: string, cy: number, target: EventTarget = el) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 41,
            pointerType: 'touch',
            isPrimary: true,
            clientX: x,
            clientY: cy,
          }),
        )
      at('pointerdown', y)
      await new Promise((done) => setTimeout(done, ms))
      if (toY !== undefined) {
        for (let i = 1; i <= 10; i++) {
          at('pointermove', y + ((toY - y) * i) / 10)
          await new Promise((done) => requestAnimationFrame(done))
        }
      }
      at('pointerup', toY ?? y)
    },
    { ms, toY },
  )
}

test('cards are ordered by hand: arrows, grip, long press; the order stays', async ({ page }) => {
  const errors = watchErrors(page)
  const list = await courseWithCards(page)
  // Imported together, in the same millisecond or not, the cards keep the file's order.
  const [a, b, c, d] = ['Alpha', 'Bravo', 'Charlie', 'Delta'] as const
  await expect.poll(() => fronts(list)).toEqual([a, b, c, d])
  const row = (name: string) => list.getByRole('listitem').filter({ hasText: name })

  // Reorder mode: arrows and grips; picking is put away meanwhile.
  await page.getByRole('button', { name: 'Reorder' }).click()
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toBeHidden()
  await expect(list.getByRole('button', { name: `Move “${a}” up` })).toBeDisabled()
  await list.getByRole('button', { name: `Move “${d}” up` }).click()
  await expect.poll(() => fronts(list)).toEqual([a, b, d, c])
  await expect(page.getByText(`“${d}” moved to position 3 of 4.`)).toBeAttached()
  expect(await seriousViolations(page)).toEqual([])

  await mouseDrag(page, row(a).locator('[data-grip]'), row(b))
  await expect.poll(() => fronts(list)).toEqual([b, a, d, c])

  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toBeVisible()

  // Outside reorder mode: a long press drags a row and does not open it; a short one is only a tap.
  const last = await row(c).boundingBox()
  if (!last) throw new Error('not on screen')
  await touchHold(row(b), 600, last.y + last.height * 0.85)
  await expect.poll(() => fronts(list)).toEqual([a, d, c, b])
  await expect(page.getByRole('heading', { level: 1, name: 'Order' })).toBeVisible()
  await touchHold(row(a), 100, last.y + last.height * 0.85)
  await expect.poll(() => fronts(list)).toEqual([a, d, c, b])

  await page.reload()
  await page.getByRole('radio', { name: 'Cards' }).check()
  await expect.poll(() => fronts(list)).toEqual([a, d, c, b])

  // A plain click still opens the card.
  await row(d).getByRole('link').click()
  await expect(page).toHaveURL(/#\/card\//)
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'Order' })).toBeVisible()

  // New cards are studied in the order shown.
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByRole('region', { name: 'Question' })).toContainText(a)
  expect(errors).toEqual([])
})
