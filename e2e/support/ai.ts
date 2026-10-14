import { expect, type Page } from '@playwright/test'

/** The AI settings' provider picker, its per-provider result lists and its one search field. */
export const providerPicker = (page: Page) => page.getByLabel('Provider', { exact: true })
export const providerGroup = (page: Page, provider: string) => page.getByRole('list', { name: provider, exact: true })
export const aiSearch = (page: Page) => page.getByRole('searchbox', { name: 'Search providers and models' })

/**
 * Sets up AI through the settings screen: picks the 302.AI route of Claude Haiku 5.5 explicitly
 * (never the default), stores `key` and points the route at `baseUrl` (a mocked provider).
 */
export async function configureAi(page: Page, baseUrl: string, key = 'sk-test-123'): Promise<void> {
  await page.goto('./#/settings/ai')
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible()
  // Nothing set up yet: the maker's own API is offered, never an aggregator.
  await expect(providerPicker(page)).toHaveValue('anthropic')
  await aiSearch(page).fill('302 haiku 5.5')
  const row = providerGroup(page, '302.AI').getByRole('button', { name: /^Claude Haiku 5\.5 claude-haiku-5-5/ })
  // Typed at once, as a user would: the key must survive the route's saved key loading.
  await row.click()
  await page.getByLabel('API key').fill(key)
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect(providerPicker(page)).toHaveValue('302ai')
  await page.getByLabel('Base URL').fill(baseUrl)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved on this device.')).toBeVisible()
}
