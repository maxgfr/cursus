import { expect, type Page } from '@playwright/test'

/** The AI settings' provider picker, its per-provider result lists and its one search field. */
export const providerPicker = (page: Page) => page.getByLabel('Provider', { exact: true })
export const providerGroup = (page: Page, provider: string) => page.getByRole('list', { name: provider, exact: true })
export const aiSearch = (page: Page) => page.getByRole('searchbox', { name: 'Search providers and models' })

/**
 * What an OpenAI-compatible server answers `content` with: streamed in small deltas (server-sent events) when the
 * request asks for a stream, as the screens that show an answer while it is written do, else one JSON completion.
 */
export function completionReply(
  request: { postDataJSON(): unknown },
  content: string,
  headers: Record<string, string>,
  model = 'claude-haiku-5-5',
): { status: number; headers: Record<string, string>; contentType: string; body: string } {
  const usage = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
  const streamed = (request.postDataJSON() as { stream?: boolean } | null)?.stream === true
  if (!streamed) {
    const json = {
      id: 'cmpl-1',
      object: 'chat.completion',
      created: 1,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage,
    }
    return { status: 200, headers, contentType: 'application/json', body: JSON.stringify(json) }
  }
  const base = { id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, model }
  const events: Record<string, unknown>[] = []
  for (let i = 0; i < content.length; i += 24) {
    const piece = content.slice(i, i + 24)
    const delta = i === 0 ? { role: 'assistant', content: piece } : { content: piece }
    events.push({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })
  }
  events.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { ...base, choices: [], usage })
  const body = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`
  return { status: 200, headers, contentType: 'text/event-stream', body }
}

/** Opens one of the AI settings' « Advanced » disclosures, unless it is open already. */
async function openDisclosure(page: Page, summary: string): Promise<void> {
  const s = page.locator('summary', { hasText: summary })
  await expect(s).toBeVisible()
  if (!(await s.evaluate((el) => (el.parentElement as HTMLDetailsElement).open))) await s.click()
}

/** Every provider and model (the catalog, its search and filters) sits behind Advanced. */
export const openModels = (page: Page) => openDisclosure(page, 'Advanced: every provider and model')
/** The base URL and the browser-access notes of a route sit behind Advanced too. */
export const openConnection = (page: Page) => openDisclosure(page, 'Advanced: address and browser access')

/**
 * Sets up AI through the settings screen: picks the 302.AI route of Claude Haiku 5.5 explicitly
 * (never the default), stores `key` and points the route at `baseUrl` (a mocked provider).
 */
export async function configureAi(page: Page, baseUrl: string, key = 'sk-test-123'): Promise<void> {
  await page.goto('./#/settings/ai')
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible()
  // Nothing set up yet: the maker's own API is offered, never an aggregator.
  await expect(providerPicker(page)).toHaveValue('anthropic')
  await openModels(page)
  await aiSearch(page).fill('302 haiku 5.5')
  const row = providerGroup(page, '302.AI').getByRole('button', { name: /^Claude Haiku 5\.5 claude-haiku-5-5/ })
  // Typed at once, as a user would: the key must survive the route's saved key loading.
  await row.click()
  await page.getByLabel('API key').fill(key)
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect(providerPicker(page)).toHaveValue('302ai')
  await openConnection(page)
  await page.getByLabel('Base URL').fill(baseUrl)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved on this device.')).toBeVisible()
}
