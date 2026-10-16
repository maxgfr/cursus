import { expect, type Page, test } from '@playwright/test'
import { FakeGitHub } from '../tests/support/fakeGitHub.ts'
import { createHarness } from './support/harness.ts'
import { seriousViolations, watchErrors } from './support/page.ts'

// A GitHub repository as a destination: a repository and a token, tested before it is added; the backup then goes
// up in a few commits, never deleting or force-pushing anything.

test.use({ serviceWorkers: 'block' })

const harness = createHarness()
test.beforeAll(async () => {
  test.setTimeout(120_000)
  await harness.build()
})
test.afterAll(() => harness.dispose())

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, X-GitHub-Api-Version, If-None-Match, Cache-Control',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE',
}

/** api.github.com answered by an in-memory repository, as the browser would reach it (CORS included). */
async function serveGitHub(page: Page, github: FakeGitHub) {
  await page.route('https://api.github.com/**', async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const body = req.postDataBuffer()
    const res = await github.fetch(req.url(), {
      method: req.method(),
      headers: await req.allHeaders(),
      ...(body ? { body: new Uint8Array(body) } : {}),
    })
    const headers: Record<string, string> = { ...CORS }
    res.headers.forEach((v, k) => {
      headers[k] = v
    })
    return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) })
  })
}

async function openGitHubForm(page: Page) {
  await page.goto('./#/settings/sync')
  await page.getByRole('button', { name: /^GitHub repository/ }).click()
  const sheet = page.getByRole('dialog', { name: 'GitHub repository' })
  await expect(sheet).toBeVisible()
  return sheet
}

test('a GitHub repository: tested, added, and the library goes up in a few commits', async ({ page }) => {
  const errors = watchErrors(page)
  const github = new FakeGitHub({ empty: true })
  await harness.seed(page, {
    courses: [{ title: 'Biology', cards: [{ front: 'Powerhouse of the cell?', back: 'The mitochondrion' }] }],
  })
  await serveGitHub(page, github)
  const sheet = await openGitHubForm(page)

  // A wrong token is said as such before anything is written.
  await sheet.getByLabel('Repository').fill('https://github.com/ada/notes')
  await sheet.getByLabel('Token').fill('github_pat_wrong')
  await sheet.getByRole('button', { name: 'Test connection' }).click()
  await expect(sheet.getByRole('alert')).toContainText('GitHub refused this token')
  expect(github.writes).toBe(0)

  await sheet.getByLabel('Token').fill(github.token)
  await sheet.getByRole('button', { name: 'Test connection' }).click()
  await expect(sheet.getByRole('status')).toHaveText('Connection works.')
  expect(await seriousViolations(page, '[role="dialog"], dialog[open]')).toEqual([])
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('ada/notes is connected.')).toBeVisible()
  await expect(page.getByTestId('sync-summary')).toContainText('confirmed in 1 backup', { timeout: 20_000 })

  // The library is in the repository's folder, as base64 text; the empty repository got a README first.
  const files = github.files()
  expect(new TextDecoder().decode(files.get('cursus/fmt/v1'))).toBe(btoa('cursus/1\n'))
  expect([...files.keys()].some((k) => k.startsWith('cursus/seg/'))).toBe(true)
  expect(files.has('cursus/README.md')).toBe(true)
  // Batched: a few commits for the whole round, nothing deleted, nothing forced.
  expect(github.messages.filter((m) => m.startsWith('Cursus backup')).length).toBeLessThanOrEqual(6)
  expect(github.deletions).toBe(0)
  expect(github.forcedUpdates).toBe(0)
  // Nothing failed but GitHub's own answers the test asked for: the wrong token (401) and the empty repository,
  // which the Git API refuses (409) until its first commit.
  expect(errors.filter((e) => !/status of (401|409)\b/.test(e))).toEqual([])
  expect(errors.filter((e) => /status of 401\b/.test(e))).toHaveLength(1)
})

test('a repository the token cannot see, or cannot write to, is explained', async ({ page }) => {
  const github = new FakeGitHub()
  github.accessible = false
  await serveGitHub(page, github)
  const sheet = await openGitHubForm(page)
  await sheet.getByLabel('Repository').fill('ada/notes')
  await sheet.getByLabel('Token').fill(github.token)
  await sheet.getByRole('button', { name: 'Test connection' }).click()
  await expect(sheet.getByRole('alert')).toContainText('give the token access to this repository')
  github.accessible = true
  github.permissions = { admin: false, push: false, pull: true }
  await sheet.getByRole('button', { name: 'Test connection' }).click()
  await expect(sheet.getByRole('alert')).toContainText('can read the repository but not write to it')
  await expect(sheet.getByRole('button', { name: 'Add', exact: true })).toBeEnabled()
  expect(github.writes).toBe(0)
})
