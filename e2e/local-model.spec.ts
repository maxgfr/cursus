import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { expect, type Page, test } from '@playwright/test'
import { type BrowserModel, listBrowserModels } from 'llm-models/browser'
import {
  type CacheLike,
  type CachesLike,
  type EngineResponse,
  fakeGpu,
  fakeLocalEngine,
  modelFiles,
  sampleJson,
  serveLocalEngine,
  type WorkerEvent,
} from '../src/core/ai/local.ts'
import { createLocalModels } from '../src/core/ai/localModels.ts'
import { openModels, providerGroup, providerPicker } from './support/ai.ts'
import { createHarness } from './support/harness.ts'
import { seriousViolations, watchErrors } from './support/page.ts'

/*
 * The "On this device" model with an injected engine: CI browsers have no usable GPU and the real
 * weights are gigabytes. As the other specs stub browser APIs (navigator.*), this one stubs WebGPU, the
 * storage estimate and the engine's Worker: the page runs its production code unchanged, the worker's
 * messages go to core's `serveLocalEngine` serving `fakeLocalEngine` here, and the fake's "weights" land
 * in the page's own Cache Storage, in WebLLM's layout. The browser still fetches the real engine
 * script, as the app would, so the service worker's runtime cache is exercised for real.
 */

const DIST = join(import.meta.dirname, '..', 'dist')
const ENGINE_CACHE = 'cursus-local-engine'
const ALL_MODELS = listBrowserModels()
const ALL_IDS = ALL_MODELS.map((m) => m.id)
const GiB = 1024 ** 3

interface DeviceSetup {
  /** What WebGPU offers: a capable adapter, none at all, no adapter, or limits below WebLLM's floor. */
  gpu: 'ok' | 'none' | 'no-adapter' | 'tiny'
  /** RAM Chromium reports, in GiB; undefined as on Safari, which never says. */
  deviceMemory?: number
  /** The origin's storage estimate; 'unknown' when the browser gives no figures. */
  storage: { usage: number; quota: number } | 'unknown'
}

const ROOMY: DeviceSetup = { gpu: 'ok', storage: { usage: 10_000_000, quota: 100 * GiB } }

/** The model core picks for a device set up like `setup`, among the models the build's engine runs. */
async function expectedPick(setup: DeviceSetup): Promise<BrowserModel> {
  const service = createLocalModels({
    env: () => ({ gpu: fakeGpu(), deviceMemory: setup.deviceMemory }),
    engine: () => fakeLocalEngine({ models: ALL_IDS }),
  })
  const r = await service.recommend()
  if (!r.supported) throw new Error(`no model fits: ${r.reason}`)
  return r.choice.model
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const nameOf = (m: BrowserModel) => (m.params_b === null ? m.series : `${m.series} ${m.params_b}B`)
/** Decimal megabytes or gigabytes, as the app writes sizes. */
function bytes(n: number): string {
  const mb = n / 1_000_000
  const unit = mb >= 1000 ? 'gigabyte' : 'megabyte'
  const value = unit === 'gigabyte' ? mb / 1000 : mb
  return new Intl.NumberFormat('en-US', {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value)
}
function weightBytes(m: BrowserModel): number {
  if (m.download_mb === null) throw new Error(`${m.id} has no published download size`)
  return Math.round(m.download_mb * 1e6)
}

/** Stubs WebGPU, the RAM figure, the storage estimate and the engine's Worker before the app loads. */
async function stubDevice(page: Page, setup: DeviceSetup) {
  await page.addInitScript((s: DeviceSetup) => {
    const GB = 1024 ** 3
    const limits =
      s.gpu === 'tiny'
        ? {
            maxBufferSize: 128 * 1024 ** 2,
            maxStorageBufferBindingSize: 64 * 1024 ** 2,
            maxComputeWorkgroupStorageSize: 16_384,
          }
        : { maxBufferSize: 4 * GB, maxStorageBufferBindingSize: 4 * GB, maxComputeWorkgroupStorageSize: 32_768 }
    const gpu =
      s.gpu === 'none'
        ? undefined
        : {
            requestAdapter: async () =>
              s.gpu === 'no-adapter'
                ? null
                : { limits, features: new Set(['shader-f16']), info: { vendor: 'fake', architecture: '' } },
          }
    Object.defineProperty(navigator, 'gpu', { configurable: true, get: () => gpu })
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => s.deviceMemory })
    const storage = s.storage
    // On the prototype: in WebKit an own property on navigator.storage does not survive exposeFunction.
    Object.defineProperty(StorageManager.prototype, 'estimate', {
      configurable: true,
      value: async () => (storage === 'unknown' ? {} : { usage: storage.usage, quota: storage.quota }),
    })

    type Listener = (event: { data: unknown }) => void
    interface Bridge {
      __cursusEngine(kind: 'open' | 'send' | 'close', id: string, json?: string): Promise<void>
      __cursusEngineDeliver(id: string, json: string): void
      __realWorker: typeof Worker
      __engineScripts: string[]
    }
    const w = window as unknown as Window & Bridge
    const Real = window.Worker
    const open = new Map<string, Listener[]>()
    w.__realWorker = Real
    w.__engineScripts = []
    w.__cursusEngineDeliver = (id, json) => {
      for (const l of open.get(id) ?? []) l({ data: JSON.parse(json) })
    }
    function EngineWorker(url: string | URL, options?: WorkerOptions) {
      if (options?.name !== 'cursus-local-model') return new Real(url, options)
      const id = crypto.randomUUID()
      w.__engineScripts.push(String(url))
      // The real script loads, as in the app (through the service worker); the injected engine answers.
      const real = new Real(url, options)
      const listeners: Listener[] = []
      open.set(id, listeners)
      void w.__cursusEngine('open', id)
      return {
        postMessage: (message: unknown) => void w.__cursusEngine('send', id, JSON.stringify(message)),
        addEventListener: (type: string, listener: Listener) => {
          if (type === 'message') listeners.push(listener)
        },
        terminate: () => {
          real.terminate()
          open.delete(id)
          void w.__cursusEngine('close', id)
        },
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: EngineWorker })
  }, setup)
}

/** The page's Cache Storage, as the fake engine writes to it. */
function pageCaches(page: Page): CachesLike {
  return {
    has: (name) => page.evaluate((n) => caches.has(n), name),
    open: async (name) => {
      const cache: CacheLike = {
        match: async (url) => {
          const text = await page.evaluate(
            async ([n, u]) => {
              const hit = await (await caches.open(n)).match(u)
              return hit ? hit.text() : null
            },
            [name, url] as const,
          )
          return text === null ? undefined : { json: async () => JSON.parse(text) }
        },
        keys: async () =>
          (await page.evaluate(async (n) => (await (await caches.open(n)).keys()).map((r) => r.url), name)).map(
            (url) => ({ url }),
          ),
        put: async (url, response) => {
          const body = [...new Uint8Array(await response.arrayBuffer())]
          await page.evaluate(
            async ([n, u, b]) => {
              await (await caches.open(n)).put(u, new Response(new Uint8Array(b)))
            },
            [name, url, body] as const,
          )
        },
        delete: (url) => page.evaluate(async ([n, u]) => (await caches.open(n)).delete(u), [name, url] as const),
      }
      return cache
    },
  }
}

interface EngineOptions {
  models?: readonly string[]
  /** Declared weight bytes of the model the test downloads, split over the fake's four shards. */
  weights?: number
  /** Awaited before a shard is fetched: holds the download where a test wants it. */
  beforeShard?: (index: number) => Promise<void>
}

interface EngineRun {
  /** Shards each engine instance fetched, in order (one entry per Worker the page started). */
  fetched: number[][]
  /** Prompts the model answered. */
  prompts: string[]
  /** Messages that could not reach the page: none may be lost. */
  failures: string[]
}

const QUIZ = {
  questions: [
    { question: 'What captures light?', choices: ['Chlorophyll', 'Starch'], answerIndex: 0, explanation: 'Pigment.' },
    { question: 'Where is CO2 fixed?', choices: ['Thylakoid', 'Stroma'], answerIndex: 1, explanation: 'Stroma.' },
  ],
}

function answer(options: LanguageModelV4CallOptions, prompts: string[]): string {
  const text = JSON.stringify(options.prompt)
  prompts.push(text)
  if (text.includes('multiple-choice')) return JSON.stringify(QUIZ)
  if (text.includes('asks what the question means')) {
    return JSON.stringify({
      restatement: 'It asks which part of the cell releases most of its energy.',
      terms: [],
      context: 'Cells release energy by respiration.',
      citations: [],
    })
  }
  // The chat, asked about a term: plain text, as it streams.
  const term = /What does “([^”]+)” mean here\?/.exec(text)?.[1]
  if (text.includes('study tutor') && term) return `${term}: what the course calls it.`
  const format = options.responseFormat
  return format?.type === 'json' ? JSON.stringify(sampleJson(format.schema)) : 'OK'
}

/** Serves the page's engine workers with core's protocol and fake engine. */
async function injectEngine(page: Page, o: EngineOptions = {}): Promise<EngineRun> {
  const models = o.models ?? ALL_IDS
  const byId = new Map(ALL_MODELS.map((m) => [m.id, m]))
  const caches = pageCaches(page)
  const run: EngineRun = { fetched: [], prompts: [], failures: [] }
  const workers = new Map<string, { listener: ((e: WorkerEvent) => void) | null; stop: AbortController }>()
  const deliver = async (id: string, message: EngineResponse) => {
    if (!workers.has(id)) return
    try {
      await page.evaluate(
        ([wid, json]) =>
          (window as unknown as { __cursusEngineDeliver(i: string, j: string): void }).__cursusEngineDeliver(wid, json),
        [id, JSON.stringify(message)] as const,
      )
    } catch (e) {
      run.failures.push(e instanceof Error ? e.message : String(e))
    }
  }
  await page.exposeFunction('__cursusEngine', (kind: 'open' | 'send' | 'close', id: string, json?: string) => {
    if (kind === 'open') {
      const fetched: number[] = []
      run.fetched.push(fetched)
      const stop = new AbortController()
      const entry: { listener: ((e: WorkerEvent) => void) | null; stop: AbortController } = { listener: null, stop }
      workers.set(id, entry)
      const engine = fakeLocalEngine({
        models,
        caches,
        shards: 4,
        shardBytes: Math.ceil((o.weights ?? 4 * 1024 * 1024) / 4),
        beforeShard: async (i) => {
          fetched.push(i)
          await o.beforeShard?.(i)
        },
        respond: (options) => answer(options, run.prompts),
      })
      serveLocalEngine(
        {
          postMessage: (message) => void deliver(id, message),
          addEventListener: (_type, listener) => {
            entry.listener = listener
          },
        },
        {
          models: () => models,
          load: (modelId, onProgress) => {
            const m = byId.get(modelId)
            if (!m) throw new Error(`${modelId} is not in llm-models' catalog`)
            // The page terminating the worker stops the download, as it stops WebLLM's.
            return engine.load({ id: modelId, files: modelFiles(m.hf_repo, m.model_lib) }, onProgress, stop.signal)
          },
          model: (modelId) => engine.languageModel(modelId),
        },
      )
    } else if (kind === 'send') {
      workers.get(id)?.listener?.({ data: JSON.parse(json ?? 'null') })
    } else {
      workers.get(id)?.stop.abort()
      workers.delete(id)
    }
  })
  return run
}

const card = (page: Page) => page.getByTestId('on-device')

async function openAi(page: Page, query = '') {
  await page.goto(`./${query}#/settings/ai`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}

test.describe('on-device model, engine injected', () => {
  test.use({ serviceWorkers: 'block' })

  test('the engine script is cached at runtime, never precached', () => {
    const sw = readFileSync(join(DIST, 'sw.js'), 'utf8')
    const manifest = /precacheAndRoute\((\[[\s\S]*?\])\s*,/.exec(sw)?.[1]
    expect(manifest).toBeDefined()
    expect(manifest).not.toContain('localModel.worker')
    // The chunk still ships, and the service worker caches it, CacheFirst, under a cursus- name.
    expect(readdirSync(join(DIST, 'assets')).filter((f) => /^localModel\.worker-[\w-]+\.js$/.test(f))).toHaveLength(1)
    expect(sw).toMatch(/localModel\\\.worker-[^)]*new \w+\.CacheFirst\(\{cacheName:"cursus-local-engine"/)
  })

  test('recommended model and why, download with progress, default model, keyless AI, remove', async ({ page }) => {
    const errors = watchErrors(page)
    const setup: DeviceSetup = { ...ROOMY, deviceMemory: 8 }
    const pick = await expectedPick(setup)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await stubDevice(page, setup)
    const run = await injectEngine(page, {
      weights: weightBytes(pick),
      beforeShard: (i) => (i === 2 ? held : Promise.resolve()),
    })
    await openAi(page)

    // The pick and why, as structured facts; its size is announced before anything is fetched.
    const facts = card(page).getByRole('definition')
    await expect(card(page).getByText(nameOf(pick), { exact: true })).toBeVisible()
    await expect(card(page).getByText('Recommended for this device')).toBeVisible()
    await expect(facts.nth(0)).toHaveText(bytes(weightBytes(pick)))
    await expect(facts.nth(1)).toContainText(
      `Needs ${Math.ceil(pick.vram_required_mb).toLocaleString('en-US')} MB of the 4,096 MB Cursus can use here`,
    )
    await expect(facts.nth(1)).toContainText('Half of the 8 GB of memory this browser reports.')
    await expect(facts.nth(2)).toContainText(pick.series)
    await expect(card(page).getByText(/^Chosen among the models that fit this device/)).toBeVisible()
    const download = card(page).getByRole('button', { name: `Download (${bytes(weightBytes(pick))})` })

    // Keyboard only: Enter starts it, focus moves to Cancel, the progress is a named progress bar.
    await download.focus()
    await page.keyboard.press('Enter')
    const cancel = card(page).getByRole('button', { name: 'Cancel' })
    await expect(cancel).toBeFocused()
    const progress = card(page).getByRole('progressbar', { name: 'Download progress' })
    await expect(progress).toHaveAttribute('aria-valuetext', '50%')
    await expect(card(page).getByRole('status')).toHaveText('Download started.')
    release()
    await expect(card(page).getByRole('status')).toHaveText('Downloaded: it works offline.')
    await expect(progress).toHaveCount(0)
    const useDefault = card(page).getByRole('button', { name: 'Use as default model' })
    await expect(useDefault).toBeFocused()

    // The default model: keyless, free, and the picker says on-device.
    await page.keyboard.press('Enter')
    await expect(providerPicker(page)).toHaveValue('on-device')
    const modelRow = page.getByRole('region', { name: 'Model', exact: true })
    await expect(modelRow).toContainText(nameOf(pick))
    await expect(modelRow).toContainText('Free, on this device')
    await expect(modelRow).toContainText('Runs offline')
    await expect(page.getByLabel('API key')).toHaveCount(0)
    await expect(
      card(page).getByText('This is your default model: every AI feature uses it, without a key.'),
    ).toBeVisible()

    // Every AI feature now works without a key: a quiz, answered by the model on this device.
    await page.goto('./#/quiz')
    await page.getByLabel('Paste text (optional)').fill('Chlorophyll captures light; CO2 is fixed in the stroma.')
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await page.getByRole('radio', { name: 'Chlorophyll' }).check()
    await page.getByRole('radio', { name: 'Stroma' }).check()
    await page.getByRole('button', { name: 'Check answers' }).click()
    await expect(page.getByText('Score: 2 / 2')).toBeVisible()
    expect(run.prompts.some((p) => p.includes('multiple-choice'))).toBe(true)
    await openAi(page)
    await expect(page.getByTestId('ai-month-cost')).toHaveText('$0.00')

    // Remove asks first (the download would have to be made again), then frees the space.
    await card(page).getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(card(page).getByRole('button', { name: 'Keep' })).toBeFocused()
    await expect(
      card(page).getByText(
        `Remove this model from the device? Using it again means downloading ${bytes(weightBytes(pick))} again.`,
      ),
    ).toBeVisible()
    await card(page).getByRole('button', { name: 'Remove model' }).click()
    await expect(card(page).getByRole('status')).toHaveText('Model removed from this device.')
    await expect(card(page).getByRole('button', { name: `Download (${bytes(weightBytes(pick))})` })).toBeFocused()
    await expect(card(page).getByText('This is your default model. Download it to use the AI features.')).toBeVisible()
    await expect(modelRow).toContainText('Not downloaded')
    const left = await page.evaluate(async () => (await (await caches.open('cursus-webllm/model')).keys()).length)
    expect(left).toBe(0)
    // Not downloaded: the AI screens send the student to the settings instead of failing.
    await page.goto('./#/quiz')
    await expect(page.getByRole('link', { name: 'Open AI settings' })).toBeVisible()
    expect(run.failures).toEqual([])
    expect(errors).toEqual([])
  })

  test('a stopped download keeps what it fetched and resumes from there', async ({ page }) => {
    const pick = await expectedPick(ROOMY)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstRun = true
    await stubDevice(page, ROOMY)
    const run = await injectEngine(page, {
      weights: weightBytes(pick),
      beforeShard: (i) => (firstRun && i === 2 ? held : Promise.resolve()),
    })
    await openAi(page)
    await card(page)
      .getByRole('button', { name: `Download (${bytes(weightBytes(pick))})` })
      .click()
    await expect(card(page).getByRole('progressbar', { name: 'Download progress' })).toHaveAttribute(
      'aria-valuetext',
      '50%',
    )
    await card(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(card(page).getByRole('status')).toHaveText(
      'Download stopped. What was already fetched stays on this device: resume to get the rest.',
    )
    firstRun = false
    release()
    const shard = Math.ceil(weightBytes(pick) / 4)
    await expect(
      card(page).getByText(`${bytes(2 * shard)} of ${bytes(4 * shard)} already on this device.`),
    ).toBeVisible()
    const resume = card(page).getByRole('button', { name: 'Resume download' })
    await expect(resume).toBeFocused()
    await resume.click()
    await expect(card(page).getByRole('status')).toHaveText('Downloaded: it works offline.')
    // The second engine fetched only what the first had not.
    expect(run.fetched.at(-1)).toEqual([2, 3])
    expect(run.failures).toEqual([])
  })

  test('a download that would crowd out the library is refused and explained', async ({ page }) => {
    await stubDevice(page, { gpu: 'ok', storage: { usage: 100_000_000, quota: 2_000_000_000 } })
    await injectEngine(page)
    await openAi(page)
    await expect(
      card(page).getByText(
        /^Not enough free space: the model needs .+, 1\.9 GB is free, and Cursus keeps 1\.1 GB for your library\.$/,
      ),
    ).toBeVisible()
    await expect(card(page).getByRole('button', { name: /^Download/ })).toBeDisabled()
  })

  test('without a storage estimate nothing is downloaded, and the card says why', async ({ page }) => {
    await stubDevice(page, { gpu: 'ok', storage: 'unknown' })
    await injectEngine(page)
    await openAi(page)
    await expect(
      card(page).getByText(
        'This browser doesn’t say how much space is free, so Cursus won’t download a model that could crowd out your library.',
      ),
    ).toBeVisible()
    await expect(card(page).getByRole('button', { name: /^Download/ })).toBeDisabled()
  })

  test('after an update, startup stores the new engine script of a downloaded model and drops the old', async ({
    page,
  }) => {
    const file = readdirSync(join(DIST, 'assets')).find((f) => /^localModel\.worker-[\w-]+\.js$/.test(f))
    // The startup check's code waits until this device holds what the previous version left (WebKit keeps
    // no Cache Storage entries across a reload here, so the state is set up in the same page load).
    let seeded = () => {}
    const ready = new Promise<void>((resolve) => {
      seeded = resolve
    })
    await page.route(/\/assets\/onDeviceStore-[\w-]+\.js$/, async (route) => {
      await ready
      await route.continue()
    })
    await page.goto('./#/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const current = new URL(`assets/${file}`, page.url().split('#')[0]).href
    const stale = new URL('assets/localModel.worker-0ld.js', current).href
    // A model downloaded by the previous version, whose engine script the runtime cache still holds.
    await page.evaluate(
      async ([old, engineCache]) => {
        await (await caches.open('cursus-webllm/model')).put(
          'https://huggingface.co/mlc-ai/m/resolve/main/params_shard_0.bin',
          new Response(new Uint8Array(8)),
        )
        await (await caches.open(engineCache)).put(old, new Response('// previous engine'))
      },
      [stale, ENGINE_CACHE] as const,
    )
    seeded()
    await expect
      .poll(() =>
        page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((r) => r.url), ENGINE_CACHE),
      )
      .toEqual([current])
  })

  test('without a downloaded model, startup leaves the engine alone', async ({ page }) => {
    const engineRequests: string[] = []
    page.on('request', (r) => {
      if (/localModel\.worker/.test(r.url())) engineRequests.push(r.url())
    })
    await page.goto('./#/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // The startup check has run once the idle callback's chunk is in: its module asks nothing more.
    await expect
      .poll(() =>
        page.evaluate(() => performance.getEntriesByType('resource').some((e) => /onDeviceStore/.test(e.name))),
      )
      .toBe(true)
    expect(await page.evaluate(() => caches.has('cursus-local-engine'))).toBe(false)
    expect(engineRequests).toEqual([])
  })

  test('opening the settings ranks the models without fetching the engine', async ({ page }) => {
    const pick = await expectedPick(ROOMY)
    await stubDevice(page, ROOMY)
    const run = await injectEngine(page, { weights: weightBytes(pick) })
    const engineRequests: string[] = []
    page.on('request', (r) => {
      if (/localModel\.worker/.test(r.url())) engineRequests.push(r.url())
    })
    await openAi(page)
    await expect(card(page).getByText(nameOf(pick), { exact: true })).toBeVisible()
    await expect(card(page).getByText('Recommended for this device')).toBeVisible()
    // Safari never reports memory: the figure is said to be an estimate.
    await expect(card(page).getByText(/^An estimate: this browser doesn’t report how much memory/)).toBeVisible()
    // The engine (a ~2 MB script, then a GPU) starts for a download or a run only.
    expect(await page.evaluate(() => (window as unknown as { __engineScripts: string[] }).__engineScripts)).toEqual([])
    expect(engineRequests).toEqual([])
    expect(run.fetched).toEqual([])
  })

  const unsupported: { name: string; setup: DeviceSetup; text: RegExp }[] = [
    {
      name: 'no WebGPU',
      setup: { ...ROOMY, gpu: 'none' },
      text: /^This browser can’t run a model on this device\./,
    },
    {
      name: 'no adapter',
      setup: { ...ROOMY, gpu: 'no-adapter' },
      text: /^This browser can’t reach the device’s graphics chip/,
    },
    {
      name: 'limits below the engine’s floor',
      setup: { ...ROOMY, gpu: 'tiny' },
      text: /^This device is too limited for any model Cursus can run here\.$/,
    },
    {
      name: 'no model fits the memory',
      setup: { ...ROOMY, deviceMemory: 0.25 },
      text: /^No model Cursus can run fits in the 128 MB of memory it can use on this device\.$/,
    },
  ]
  for (const c of unsupported) {
    test(`unsupported device explained: ${c.name}`, async ({ page }) => {
      await stubDevice(page, c.setup)
      await injectEngine(page)
      await openAi(page)
      await expect(card(page).getByText(c.text)).toBeVisible()
      if (c.setup.deviceMemory !== undefined) {
        await expect(card(page).getByText(/^Half of the .+ of memory this browser reports\.$/)).toBeVisible()
      }
      await expect(card(page).getByRole('button', { name: /^Download/ })).toHaveCount(0)
    })
  }

  test('on-device is a provider in the picker and the search, keyless', async ({ page }) => {
    const pick = await expectedPick(ROOMY)
    await stubDevice(page, ROOMY)
    await injectEngine(page, { weights: weightBytes(pick) })
    await openAi(page)
    await expect(providerPicker(page)).toHaveValue('anthropic')
    await providerPicker(page).selectOption({ label: 'On this device' })
    await expect(providerPicker(page)).toHaveValue('on-device')
    const modelRow = page.getByRole('region', { name: 'Model', exact: true })
    await expect(modelRow).toContainText(nameOf(pick))
    await expect(modelRow).toContainText('Not downloaded')
    // No key, no base URL, no connection form: the card takes its place.
    await expect(page.getByLabel('API key')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /^Connection to/ })).toHaveCount(0)
    await openModels(page)
    const list = providerGroup(page, 'On this device')
    await expect(
      list.getByRole('button', { name: new RegExp(`^${escapeRe(nameOf(pick))} ${escapeRe(pick.id)}`) }),
    ).toHaveAttribute('aria-pressed', 'true')

    // The search finds it by name like any provider, and never for an unrelated model.
    const search = page.getByRole('searchbox', { name: 'Search providers and models' })
    await search.fill('haiku 5.5')
    await expect(list).toHaveCount(0)
    await search.fill('on this device')
    await expect(list).toBeVisible()
    const other = list.getByRole('button').nth(1)
    await other.click()
    await expect(other).toHaveAttribute('aria-pressed', 'true')
    const otherName = (await other.locator('span[translate="no"]').first().textContent()) ?? ''
    await expect(modelRow).toContainText(otherName)
    await expect(card(page).getByText(otherName, { exact: true })).toBeVisible()
    await expect(card(page).getByText('This is your default model. Download it to use the AI features.')).toBeVisible()

    // Back to a cloud provider: its key and connection form return.
    await providerPicker(page).selectOption('anthropic')
    await expect(page.getByLabel('API key')).toBeVisible()
    await expect(card(page).getByRole('button', { name: 'Use as default model' })).toHaveCount(0)
  })

  test('German and dark, light: the card fits the screen and passes axe', async ({ page }) => {
    const errors = watchErrors(page)
    await stubDevice(page, ROOMY)
    await injectEngine(page)
    await openAi(page, '?locale=de')
    await expect(card(page).getByRole('heading', { name: 'Auf diesem Gerät' })).toBeVisible()
    await expect(card(page).getByRole('button', { name: /^Herunterladen \(/ })).toBeVisible()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
      expect(await seriousViolations(page, '[data-testid="on-device"]')).toEqual([])
    }
    expect(errors).toEqual([])
  })
})

test.describe('on-device model offline, explanations', () => {
  test.use({ serviceWorkers: 'block' })
  const harness = createHarness()
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    await harness.build()
  })
  test.afterAll(() => harness.dispose())

  /** Moves within the app without reloading it: offline, the code already loaded keeps working. */
  const go = (page: Page, hash: string) =>
    page.evaluate((h) => {
      location.hash = h
    }, hash)

  /** Selects `word` in the first text node under `container` that holds it, as a long press would. */
  async function selectText(page: Page, container: string, word: string) {
    await page
      .locator(container)
      .first()
      .evaluate((root, w) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const at = n.textContent?.indexOf(w) ?? -1
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(n, at)
          range.setEnd(n, at + w.length)
          document.getSelection()?.removeAllRanges()
          document.getSelection()?.addRange(range)
          return
        }
        throw new Error(`"${w}" is not on the page`)
      }, word)
  }

  test('a model on this device answers with no connection: a term asked about in the chat and the review card', async ({
    page,
    context,
  }, info) => {
    const errors = watchErrors(page)
    await harness.seed(page, {
      courses: [
        {
          title: 'Biology',
          notes: [{ title: 'Cell notes', body: 'The mitochondrion produces ATP through cellular respiration.' }],
          cards: [{ front: 'Powerhouse of the cell?', back: 'The mitochondrion' }],
        },
      ],
    })
    const pick = await expectedPick(ROOMY)
    await stubDevice(page, ROOMY)
    const run = await injectEngine(page, { weights: weightBytes(pick) })
    await openAi(page)
    await card(page)
      .getByRole('button', { name: `Download (${bytes(weightBytes(pick))})` })
      .click()
    await expect(card(page).getByRole('status')).toHaveText('Downloaded: it works offline.')
    await card(page).getByRole('button', { name: 'Use as default model' }).click()
    await expect(providerPicker(page)).toHaveValue('on-device')

    // Online first, so the screens' code is loaded (the service worker is off in this run).
    await go(page, '#/review')
    // The explanation answers in the chat, whose code loads with it; then the chat is closed.
    await page.getByRole('main').getByRole('button', { name: 'Explain the question', exact: true }).click()
    const question =
      info.project.name === 'webkit-iphone'
        ? page.getByRole('dialog', { name: 'Ask' })
        : page.getByRole('complementary', { name: 'Ask' })
    await expect(question.getByText('It asks which part of the cell releases most of its energy.')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Your question' })).toBeVisible()
    await page.keyboard.press(info.project.name === 'webkit-iphone' ? 'Escape' : 'ControlOrMeta+j')
    await expect(question).toBeHidden()
    await go(page, '#/courses')
    await page
      .getByRole('main')
      .getByRole('link', { name: /Biology/ })
      .click()
    await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
    await page
      .getByRole('main')
      .getByRole('link', { name: /Cell notes/ })
      .click()
    await expect(page.locator('.cm-content')).toContainText('produces ATP')

    await context.setOffline(true)
    await selectText(page, '.cm-content', 'ATP')
    await page.getByRole('button', { name: 'Ask about “ATP”' }).click()
    const chat =
      info.project.name === 'webkit-iphone'
        ? page.getByRole('dialog', { name: 'Ask' })
        : page.getByRole('complementary', { name: 'Ask' })
    await expect(chat.getByText('ATP: what the course calls it.')).toBeVisible()
    await expect(chat.getByText('You are offline. Asking needs a connection, or a model on this device.')).toHaveCount(
      0,
    )
    if (info.project.name === 'webkit-iphone') await chat.getByRole('button', { name: 'Close' }).click()

    await go(page, '#/review')
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Explain the question', exact: true }),
    ).toBeEnabled()
    await selectText(page, '[data-testid="question"]', 'cell')
    await expect(page.getByRole('button', { name: 'Ask about “cell”' })).toBeEnabled()
    await expect(page.getByText('You’re offline. Explanations need a connection.')).toHaveCount(0)
    await context.setOffline(false)
    expect(run.prompts.some((p) => p.includes('Passage the student selected a term in'))).toBe(true)
    expect(run.failures).toEqual([])
    expect(errors).toEqual([])
  })
})

test.describe('on-device model offline', () => {
  async function waitForController(page: Page) {
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
    })
    // The first visit is not controlled until the next navigation.
    await page.reload()
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
  }

  test('after the download, the model runs with no network: the engine comes from the runtime cache', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000)
    const pick = await expectedPick(ROOMY)
    await stubDevice(page, ROOMY)
    const run = await injectEngine(page, { weights: weightBytes(pick) })
    await openAi(page)
    await waitForController(page)
    await card(page)
      .getByRole('button', { name: `Download (${bytes(weightBytes(pick))})` })
      .click()
    await expect(card(page).getByRole('status')).toHaveText('Downloaded: it works offline.')
    await card(page).getByRole('button', { name: 'Use as default model' }).click()
    await expect(providerPicker(page)).toHaveValue('on-device')

    // The engine script the page loaded is in the runtime cache, not the precache.
    const script = await page.evaluate(() =>
      (window as unknown as { __engineScripts: string[] }).__engineScripts.at(-1),
    )
    expect(script).toMatch(/\/assets\/localModel\.worker-[\w-]+\.js$/)
    await expect
      .poll(() =>
        page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((r) => r.url), ENGINE_CACHE),
      )
      .toContain(script)

    // Cut off, cold start: the quiz runs on the model here, and nothing goes out.
    await context.setOffline(true)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const outgoing: string[] = []
    const origin = new URL(page.url()).origin
    page.on('request', (r) => {
      if (new URL(r.url()).origin !== origin) outgoing.push(r.url())
    })
    await page.evaluate(() => {
      location.hash = '#/quiz'
    })
    await page.getByLabel('Paste text (optional)').fill('Chlorophyll captures light; CO2 is fixed in the stroma.')
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await page.getByRole('radio', { name: 'Chlorophyll' }).check()
    await page.getByRole('radio', { name: 'Stroma' }).check()
    await page.getByRole('button', { name: 'Check answers' }).click()
    await expect(page.getByText('Score: 2 / 2')).toBeVisible()
    expect(outgoing).toEqual([])

    // The real engine script, not the injected one, starts offline from that cache and answers.
    const reply = await page.evaluate(
      (url) =>
        new Promise<unknown>((resolve, reject) => {
          const Real = (window as unknown as { __realWorker: typeof Worker }).__realWorker
          const worker = new Real(url, { type: 'module' })
          worker.addEventListener('message', (e) => {
            resolve(e.data)
            worker.terminate()
          })
          worker.addEventListener('error', (e) => reject(new Error(e.message || 'the engine script did not load')))
          worker.postMessage({ id: 1, op: 'models' })
        }),
      script ?? '',
    )
    expect(reply).toMatchObject({ id: 1, kind: 'models' })
    expect((reply as { ids: string[] }).ids).toContain(pick.id)
    expect(run.failures).toEqual([])
  })
})
