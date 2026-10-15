import { expect, test } from 'bun:test'
import { type BrowserContext, chromium, type Page } from '@playwright/test'
import { type Subprocess, spawn } from 'bun'

/*
 * The real on-device model: WebLLM on this machine's GPU, the weights downloaded from Hugging Face
 * (hundreds of megabytes to gigabytes), driven through the built app exactly as a student would. Run
 * `bun run build` first. Opt in with LIVE_WEBLLM=1; optional:
 *   LIVE_WEBLLM_MODEL    a WebLLM model id to use instead of the one picked for this device
 *                        (a small one, e.g. Qwen3-0.6B-q4f16_1-MLC, keeps the download short);
 *   LIVE_WEBLLM_PROFILE  a browser profile folder kept between runs, so the weights download once;
 *   LIVE_WEBLLM_CHANNEL  a Chromium channel such as `chrome` (Google Chrome's own WebGPU);
 *   LIVE_WEBLLM_HEADED=1 shows the browser.
 */

const enabled = process.env.LIVE_WEBLLM === '1'
const PORT = 4183
const BASE = `http://localhost:${PORT}/cursus/`
const MINUTE = 60_000

async function serve(): Promise<Subprocess> {
  const server = spawn(['bunx', 'vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdout: 'ignore',
    stderr: 'inherit',
  })
  for (let i = 0; i < 100; i++) {
    const up = await fetch(BASE).then(
      (r) => r.ok,
      () => false,
    )
    if (up) return server
    await Bun.sleep(100)
  }
  server.kill()
  throw new Error(`vite preview did not answer on ${BASE}: run \`bun run build\` first`)
}

async function open(): Promise<BrowserContext> {
  const options = {
    headless: process.env.LIVE_WEBLLM_HEADED !== '1',
    args: ['--enable-unsafe-webgpu'],
    ...(process.env.LIVE_WEBLLM_CHANNEL ? { channel: process.env.LIVE_WEBLLM_CHANNEL } : {}),
  }
  const profile = process.env.LIVE_WEBLLM_PROFILE
  if (profile) return chromium.launchPersistentContext(profile, options)
  const browser = await chromium.launch(options)
  return browser.newContext()
}

async function pickModel(page: Page, modelId: string) {
  await page.getByRole('searchbox', { name: 'Search providers and models' }).fill('on this device')
  const row = page
    .getByRole('list', { name: 'On this device', exact: true })
    .getByRole('button')
    .filter({ hasText: modelId })
  await row.click()
  await row.and(page.locator('[aria-pressed="true"]')).waitFor()
}

if (!enabled) {
  test.skip('live WebLLM: skipped, set LIVE_WEBLLM=1 (after `bun run build`)', () => {})
} else {
  test(
    'live WebLLM: the model picked for this device downloads, then runs a quiz offline',
    async () => {
      const server = await serve()
      const context = await open()
      try {
        const page = context.pages()[0] ?? (await context.newPage())
        await page.goto(`${BASE}#/settings/ai`)
        const card = page.getByTestId('on-device')
        // The real detection and ranking: this machine must offer WebGPU with enough memory.
        const start = card.getByRole('button', { name: /^(Download|Resume download)/ })
        const ready = card.getByText('Downloaded: it works offline.')
        await start
          .or(ready)
          .first()
          .waitFor({ timeout: 2 * MINUTE })
        const wanted = process.env.LIVE_WEBLLM_MODEL
        if (wanted) await pickModel(page, wanted)
        if (await start.isVisible()) {
          await start.click()
          await ready.waitFor({ timeout: 45 * MINUTE })
        }
        const useDefault = card.getByRole('button', { name: 'Use as default model' })
        if (await useDefault.isVisible()) await useDefault.click()
        await expect(page.getByLabel('Provider', { exact: true }).inputValue()).resolves.toBe('on-device')

        // Weights, config, tokenizer and library are in the app's own caches, the engine's script too.
        const names = await page.evaluate(() => caches.keys())
        expect(names).toEqual(
          expect.arrayContaining(['cursus-webllm/model', 'cursus-webllm/wasm', 'cursus-local-engine']),
        )

        // No network from here, and a cold start: the app, the engine and the weights all come from this
        // device, and the quiz is written by the model on this machine.
        await page.evaluate(async () => {
          await navigator.serviceWorker.ready
        })
        await context.setOffline(true)
        await page.reload()
        await page.evaluate(() => {
          location.hash = '#/quiz'
        })
        await page
          .getByLabel('Paste text (optional)')
          .fill(
            'Photosynthesis: chlorophyll in the thylakoids captures light; the Calvin cycle fixes CO2 into sugar in the stroma.',
          )
        await page.getByRole('radio', { name: '3' }).check({ force: true })
        await page.getByRole('button', { name: 'Start quiz' }).click()
        await page.getByRole('button', { name: 'Check answers' }).waitFor({ timeout: 10 * MINUTE })
        await page.getByRole('button', { name: 'Check answers' }).click()
        await page.getByText(/^Score: \d+ \/ \d+$/).waitFor()
      } finally {
        await context.close()
        server.kill()
      }
    },
    60 * MINUTE,
  )
}
