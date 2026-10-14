import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('app shell renders', async ({ page }) => {
  await page.goto('./')
  // The page's one h1 (Today) leads the main landmark; the brand is not a heading read before it.
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Cursus' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Today' })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})
