import { describe, expect, test } from 'bun:test'
import { ModelType, prebuiltAppConfig } from '@mlc-ai/web-llm'
import { generateText, Output } from 'ai'
import { listBrowserModels, recommendBrowserModel } from 'llm-models/browser'
import { z } from 'zod'
import { ENGINE_MODELS } from './engineModels'
import {
  detectLocalSupport,
  type FakeEngine,
  type FakeEngineOptions,
  fakeGpu,
  fakeLocalEngine,
  type GpuReport,
  LOCAL_PROVIDER,
  type LocalDetection,
  LocalModelError,
  type StorageLike,
} from './local'
import { memoryCaches } from './localkit.test'
import {
  callDefaults,
  createLocalModels,
  downloadBytesOf,
  findLocalModel,
  LOCAL_NEEDS,
  localModelInfo,
  recommendLocal,
} from './localModels'
import { usageEvent } from './usage'

const GiB = 1024 ** 3
/** The models the installed WebLLM (the one the worker bundles) runs. */
const ENGINE_IDS: ReadonlySet<string> = new Set(prebuiltAppConfig.model_list.map((m) => m.model_id))

function model(id: string) {
  const m = findLocalModel(id)
  if (!m) throw new Error(`${id} is not in llm-models' catalog`)
  return m
}

async function detected(deviceMemory?: number, gpu = fakeGpu()): Promise<LocalDetection> {
  return detectLocalSupport({ gpu, deviceMemory })
}

function report(budget: number, shaderF16: boolean, lowResource = false): LocalDetection {
  const gpu: GpuReport = {
    vendor: 'test',
    architecture: '',
    maxBufferSize: 4 * GiB,
    maxStorageBufferBindingSize: lowResource ? GiB / 2 : 4 * GiB,
    maxComputeWorkgroupStorageSize: 32 * 1024,
    shaderF16,
    deviceMemoryGiB: null,
    memoryBudgetMB: budget,
    memorySource: 'default',
    lowResource,
  }
  return { supported: true, gpu }
}

describe('recommendation', () => {
  test('8 GiB of RAM with fp16: 4096 MB, Qwen 3.5 0.8B by default, then llm-models ranking', async () => {
    const r = recommendLocal(await detected(8), ENGINE_IDS)
    expect(r.supported && r.choice.model.id).toBe('Qwen3.5-0.8B-q4f16_1-MLC')
    expect(r.supported && r.choice.reason).toContain('4096 MB budget')
    expect(r.supported && r.choice.memoryMB).toBe(model('Qwen3.5-0.8B-q4f16_1-MLC').vram_required_mb)
    const runnable = listBrowserModels().filter((m) => ENGINE_IDS.has(m.id))
    const ranked = recommendBrowserModel(
      { vram_budget_mb: 4096, needs: [...LOCAL_NEEDS], shader_f16: true, low_resource: false },
      runnable,
    )
    if (!ranked) throw new Error('llm-models ranks nothing at 4096 MB')
    expect(r.supported && r.choice.alternatives[0]?.id).toBe('Qwen3.5-4B-q4f16_1-MLC')
    expect(r.supported && r.choice.alternatives.map((m) => m.id)).toEqual(
      [ranked.model, ...ranked.alternatives].map((m) => m.id).filter((id) => !id.startsWith('Qwen3.5-0.8B')),
    )
  })

  test('without fp16 the default is the q4f32 Qwen 3.5 0.8B build', async () => {
    const r = recommendLocal(await detected(8, fakeGpu({ shaderF16: false })), ENGINE_IDS)
    expect(r.supported && r.choice.model.id).toBe('Qwen3.5-0.8B-q4f32_1-MLC')
  })

  test('too little memory for Qwen 3.5 0.8B: llm-models picks a smaller model', () => {
    for (const [budget, f16] of [
      [1500, true],
      [1800, false],
    ] as const) {
      const r = recommendLocal(report(budget, f16), ENGINE_IDS)
      const runnable = listBrowserModels().filter((m) => ENGINE_IDS.has(m.id))
      const expected = recommendBrowserModel(
        { vram_budget_mb: budget, needs: [...LOCAL_NEEDS], shader_f16: f16, low_resource: false },
        runnable,
      )
      expect(expected).not.toBeNull()
      expect(r.supported && r.choice.model.id).toBe(expected?.model.id ?? false)
      expect(r.supported && r.choice.model.id).not.toStartWith('Qwen3.5-0.8B')
    }
  })

  test('the device facts map onto llm-models options one to one', async () => {
    for (const [d, opts] of [
      [await detected(), { vram_budget_mb: 2048, shader_f16: true, low_resource: false }],
      [
        await detected(4, fakeGpu({ shaderF16: false })),
        { vram_budget_mb: 2048, shader_f16: false, low_resource: false },
      ],
      [
        await detected(16, fakeGpu({ maxStorageBufferBindingSize: GiB / 2 })),
        { vram_budget_mb: 8192, shader_f16: true, low_resource: true },
      ],
    ] as const) {
      const runnable = listBrowserModels().filter((m) => ENGINE_IDS.has(m.id))
      const options = { ...opts, needs: [...LOCAL_NEEDS] }
      const ranked = recommendBrowserModel(options, runnable)
      // The default model wherever it fits these options; llm-models' ranking for the rest.
      const isDefault = (id: string) => id.startsWith('Qwen3.5-0.8B')
      const preferred = recommendBrowserModel(
        options,
        runnable.filter((m) => isDefault(m.id)),
      )
      const r = recommendLocal(d, ENGINE_IDS)
      expect(r.supported && r.choice.model.id).toBe(preferred?.model.id ?? ranked?.model.id ?? false)
      expect(r.supported && r.choice.alternatives.map((m) => m.id)).toEqual(
        preferred
          ? [ranked?.model, ...(ranked?.alternatives ?? [])].flatMap((m) => (m && !isDefault(m.id) ? [m.id] : []))
          : (ranked?.alternatives.map((m) => m.id) ?? []),
      )
    }
  })

  test('without fp16 the pick is a q4f32 build', async () => {
    const r = recommendLocal(await detected(8, fakeGpu({ shaderF16: false })), ENGINE_IDS)
    expect(r.supported && r.choice.model.compute_dtype).toBe('f32')
  })

  test('only models the installed engine runs are offered', () => {
    // llm-models' catalog may be newer than the installed WebLLM: builds the engine does not have,
    // the default model's among them, are listed next to the real ones.
    const unknown = listBrowserModels().flatMap((m) => [{ ...m, id: `${m.id}-next` }, m])
    const unfiltered = recommendBrowserModel(
      { vram_budget_mb: 4000, needs: [...LOCAL_NEEDS], shader_f16: false },
      unknown,
    )
    const all = [unfiltered?.model, ...(unfiltered?.alternatives ?? [])].map((m) => m?.id ?? '')
    expect(all.some((id) => !ENGINE_IDS.has(id))).toBe(true)
    for (const budget of [1024, 1536, 2048, 3000, 4000, 4096, 6000, 8192, 16384]) {
      for (const f16 of [true, false]) {
        for (const low of [true, false]) {
          const r = recommendLocal(report(budget, f16, low), ENGINE_IDS, unknown)
          if (!r.supported) continue
          for (const m of [r.choice.model, ...r.choice.alternatives]) expect(ENGINE_IDS.has(m.id)).toBe(true)
        }
      }
    }
  })

  test('nothing fits: too little memory; an unsupported detection passes through', async () => {
    const r = recommendLocal(await detected(0.25), ENGINE_IDS)
    expect(r.supported ? null : r.reason).toBe('too-little-memory')
    expect(recommendLocal({ supported: false, reason: 'no-webgpu' }, ENGINE_IDS)).toEqual({
      supported: false,
      reason: 'no-webgpu',
    })
    expect(recommendLocal(report(4096, true), new Set()).supported).toBe(false)
  })

  test('download size comes from the shard list, not the rounded MB', () => {
    expect(downloadBytesOf(model('Qwen3.5-2B-q4f16_1-MLC'))).toBe(1_059_315_328)
  })
})

describe('the model as the app sees it', () => {
  test('free: usage is recorded at zero cost', () => {
    const info = localModelInfo(model('Qwen3-1.7B-q4f16_1-MLC'))
    expect(info).toEqual({
      id: 'Qwen3-1.7B-q4f16_1-MLC',
      name: 'Qwen3 1.7B',
      provider: LOCAL_PROVIDER,
      context_length: 4096,
      cost: { input: 0, output: 0 },
      modalities: { input: ['text'] },
      capabilities: { structured_output: true, reasoning: true },
      release_date: '2025-04',
    })
    expect(usageEvent('quiz', info, { inputTokens: 900, outputTokens: 300 }, 1).cost).toBe(0)
  })

  test('hybrid thinkers are told not to think; other models get no WebLLM option', () => {
    expect(callDefaults(model('Qwen3-1.7B-q4f16_1-MLC'))).toEqual({
      'web-llm': { extra_body: { enable_thinking: false } },
    })
    expect(callDefaults(model('Llama-3.2-1B-Instruct-q4f16_1-MLC'))).toBeUndefined()
  })
})

const ID = 'Qwen3-1.7B-q4f16_1-MLC'
const OTHER = 'Qwen3-0.6B-q4f16_1-MLC'

function service(o: { storage?: StorageLike | null; fake?: Partial<FakeEngineOptions> } = {}) {
  const caches = memoryCaches()
  const engines: FakeEngine[] = []
  const storage: StorageLike | undefined =
    o.storage === null ? undefined : (o.storage ?? { estimate: async () => ({ usage: 0, quota: 20 * GiB }) })
  const local = createLocalModels({
    env: () => ({ gpu: fakeGpu(), deviceMemory: 4 }),
    engineModels: [ID, OTHER],
    engine: () => {
      const e = fakeLocalEngine({ models: [ID, OTHER], caches, ...o.fake })
      engines.push(e)
      return e
    },
    storage,
    caches,
  })
  return { local, caches, engines }
}

describe('service', () => {
  test('recommend ranks the models the engine runs without starting it', async () => {
    const { local, engines } = service()
    const r = await local.recommend()
    expect(r.supported && r.choice.model.id).toBe(ID)
    expect((await local.detect()).supported).toBe(true)
    // Ranking reads the ids extracted at build time: no worker, no engine script fetched.
    expect(engines).toHaveLength(0)
  })

  test('by default, the engine ids are those of the installed WebLLM, as its worker lists them', async () => {
    // Out of date after a WebLLM upgrade: run `bun scripts/build-engine-models.ts`.
    const llms = prebuiltAppConfig.model_list.filter((m) => (m.model_type ?? ModelType.LLM) === ModelType.LLM)
    expect(ENGINE_MODELS).toEqual(llms.map((m) => m.model_id))
    const engines: FakeEngine[] = []
    const local = createLocalModels({
      env: () => ({ gpu: fakeGpu(), deviceMemory: 8 }),
      engine: () => {
        const e = fakeLocalEngine({ models: [] })
        engines.push(e)
        return e
      },
    })
    // The Gemma 4 build llm-models lists but this WebLLM lacks stays out, as with the engine's own list.
    const r = await local.recommend()
    expect(r).toEqual(recommendLocal(await detected(8), new Set(llms.map((m) => m.model_id))))
    for (const m of r.supported ? [r.choice.model, ...r.choice.alternatives] : [])
      expect(ENGINE_IDS.has(m.id)).toBe(true)
    expect(engines).toHaveLength(0)
  })

  test('download: space checked, progress, resumable after a stop, then usable offline', async () => {
    let stopAt = 2
    const stop = new AbortController()
    const { local, engines } = service({
      fake: {
        beforeShard: async (i) => {
          if (i === stopAt) stop.abort()
        },
      },
    })
    const h = local.handle(model(ID))
    expect(await h.isDownloaded()).toBe(false)
    expect(await h.checkSpace()).toMatchObject({ ok: true, needBytes: (h.downloadBytes ?? 0) + 64 * 1024 ** 2 })

    await expect(h.download(() => {}, stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(engines[0]?.disposed).toBe(true)
    expect(await h.state()).toMatchObject({ complete: false, cachedBytes: 2 * 1024 ** 2 })
    // What remains is measured from the cache once the shard list is known.
    expect(await h.checkSpace()).toMatchObject({ ok: true, needBytes: 2 * 1024 ** 2 + 64 * 1024 ** 2 })

    stopAt = -1
    const fractions: number[] = []
    await h.download((p) => fractions.push(p.fraction))
    expect(fractions).toEqual([0.25, 0.5, 0.75, 1])
    expect(await h.isDownloaded()).toBe(true)
    expect(await h.checkSpace()).toMatchObject({ ok: true, needBytes: 0 })

    const schema = z.object({ answer: z.string() })
    const res = await generateText({
      model: await local.languageModel(ID),
      prompt: 'P',
      output: Output.object({ schema }),
    })
    expect(res.output).toEqual({ answer: 'x' })
    expect(engines[1]?.calls[0]?.providerOptions).toEqual({ 'web-llm': { extra_body: { enable_thinking: false } } })
  })

  test('refuses a download that would eat into the library, and explains', async () => {
    const tight = service({ storage: { estimate: async () => ({ usage: 3 * GiB, quota: 5 * GiB }) } })
    const h = tight.local.handle(model(ID))
    const err = await h.download().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LocalModelError)
    expect(err instanceof LocalModelError && err.code).toBe('no-space')
    expect(err instanceof LocalModelError && err.space).toMatchObject({
      ok: false,
      reason: 'not-enough-space',
      freeBytes: 2 * GiB,
      reserveBytes: 3 * GiB,
    })
    expect(tight.engines).toHaveLength(0)

    const blind = service({ storage: null })
    await expect(blind.local.handle(model(ID)).download()).rejects.toMatchObject({
      code: 'no-space',
      space: { ok: false, reason: 'unknown' },
    })
  })

  test('an engine that loads without filling the cache is caught', async () => {
    const caches = memoryCaches()
    const local = createLocalModels({
      env: () => ({ gpu: fakeGpu() }),
      engine: () => fakeLocalEngine({ models: [ID] }),
      storage: { estimate: async () => ({ usage: 0, quota: 20 * GiB }) },
      caches,
    })
    await expect(local.handle(model(ID)).download()).rejects.toMatchObject({ code: 'engine' })
  })

  test('a model not downloaded is refused before any engine starts', async () => {
    const { local, engines } = service()
    await expect(local.languageModel(ID)).rejects.toMatchObject({ code: 'not-downloaded' })
    await expect(local.languageModel('not-a-model')).rejects.toMatchObject({ code: 'unsupported-model' })
    expect(engines).toHaveLength(0)
  })

  test('one model at a time; remove frees the engine and the space', async () => {
    const { local, engines, caches } = service()
    await local.handle(model(ID)).download()
    await local.handle(model(OTHER)).download()
    expect(engines.map((e) => e.disposed)).toEqual([true, false])
    expect(engines[1]?.loaded.has(OTHER)).toBe(true)

    await local.handle(model(OTHER)).remove()
    expect(engines[1]?.disposed).toBe(true)
    expect(await local.handle(model(OTHER)).isDownloaded()).toBe(false)
    expect(await local.handle(model(ID)).isDownloaded()).toBe(true)
    expect(caches.names().every((n) => n.startsWith('cursus-'))).toBe(true)
  })

  test('detect and info', async () => {
    const { local } = service()
    expect((await local.detect()).supported).toBe(true)
    expect(local.info(ID)?.cost).toEqual({ input: 0, output: 0 })
    expect(local.info('nope')).toBeUndefined()
  })
})
