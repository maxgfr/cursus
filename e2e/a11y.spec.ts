import { expect, test } from '@playwright/test'
import { createHarness } from './support/harness.ts'
import { seriousViolations, watchErrors } from './support/page.ts'
import { mainScreens, openScreen, seedLibrary } from './support/screens.ts'

test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

for (const colorScheme of ['light', 'dark'] as const) {
  test(`axe: no serious or critical violation on any main screen, ${colorScheme}`, async ({ page }) => {
    test.setTimeout(180_000)
    const errors = watchErrors(page)
    await page.emulateMedia({ colorScheme })
    await seedLibrary(harness, page, 'Cell biology')
    const problems: string[] = []
    for (const hash of await mainScreens(page)) {
      await openScreen(page, '', hash)
      for (const v of await seriousViolations(page)) problems.push(`${hash} ${v}`)
    }
    // The review card with its answer and grades shown, and the new-course sheet.
    await openScreen(page, '', '#/review')
    await page.getByRole('button', { name: /Show answer/ }).click()
    await expect(page.getByTestId('answer')).toBeVisible()
    for (const v of await seriousViolations(page)) problems.push(`#/review (answer) ${v}`)
    await openScreen(page, '', '#/')
    await page.getByRole('button', { name: 'New course' }).first().click()
    await expect(page.getByRole('dialog', { name: 'New course' })).toBeVisible()
    for (const v of await seriousViolations(page, 'dialog[open]')) problems.push(`new course sheet ${v}`)
    expect(problems).toEqual([])
    expect(errors).toEqual([])
  })
}
