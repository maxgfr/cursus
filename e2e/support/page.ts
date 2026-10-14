import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

/** Collects console errors and uncaught exceptions for the whole test. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

export const isPhone = (project: string) => project === 'webkit-iphone'

/** Hash navigation inside the running page: no reload, so it also works offline. */
export async function go(page: Page, hash: string, heading: string | RegExp = /./) {
  await page.evaluate((h) => {
    location.hash = h
  }, hash)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
}

export async function createCourse(page: Page, title: string) {
  await page.getByRole('button', { name: 'New course' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New course' })
  await dialog.getByLabel('Course name').fill(title)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

export async function typeInto(page: Page, label: string, text: string) {
  await page.getByRole('textbox', { name: label }).click()
  await page.keyboard.type(text)
}

/** Waits until no finite animation or transition runs: contrast and layout are measured on the settled screen. */
export async function settle(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY,
            ).length,
      ),
    )
    .toBe(0)
}

/** Serious and critical axe violations of the settled page (or of `include` only), with their targets. */
export async function seriousViolations(page: Page, include?: string): Promise<string[]> {
  await settle(page)
  const builder = new AxeBuilder({ page })
  if (include) builder.include(include)
  const results = await builder.analyze()
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}
