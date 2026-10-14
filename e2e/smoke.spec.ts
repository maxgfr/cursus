import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('app shell renders', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Cursus' })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})
