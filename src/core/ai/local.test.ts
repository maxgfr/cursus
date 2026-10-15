import { describe, expect, test } from 'bun:test'
import { generateText, Output, streamText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import {
  CACHE_PREFIX,
  cacheName,
  checkSpace,
  connectWorkerEngine,
  detectLocalSupport,
  type EngineBackend,
  fakeGpu,
  fakeLocalEngine,
  LIBRARY_RESERVE_MIN_BYTES,
  type LoadProgress,
  LocalModelError,
  modelCacheState,
  modelFiles,
  prefixedCaches,
  removeModelFiles,
  sampleJson,
  serveLocalEngine,
  WEBLLM_SCOPES,
  type WorkerEvent,
  type WorkerLike,
} from './local'
import { memoryCaches } from './localkit.test'
import { jsonModel, streamModel } from './testkit.test'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

const QWEN = modelFiles(
  'https://huggingface.co/mlc-ai/Qwen3.5-2B-q4f16_1-MLC',
  'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base/Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm',
)
const target = { id: 'Qwen3.5-2B-q4f16_1-MLC', files: QWEN }

describe('detection', () => {
  test('no navigator.gpu, no adapter', async () => {
    expect(await detectLocalSupport({})).toEqual({ supported: false, reason: 'no-webgpu' })
    expect(await detectLocalSupport({ gpu: fakeGpu({ adapter: false }) })).toEqual({
      supported: false,
      reason: 'no-adapter',
    })
  })

  test('limits below what WebLLM needs mean too little memory', async () => {
    for (const limits of [
      { maxBufferSize: 128 * MiB },
      { maxStorageBufferBindingSize: 64 * MiB },
      { maxComputeWorkgroupStorageSize: 16 * 1024 },
    ]) {
      const d = await detectLocalSupport({ gpu: fakeGpu(limits) })
      expect(d.supported).toBe(false)
      expect(!d.supported && d.reason).toBe('too-little-memory')
    }
  })

  test('budget: half the RAM the browser reports, a phone-sized default otherwise', async () => {
    const chrome = await detectLocalSupport({ gpu: fakeGpu(), deviceMemory: 8 })
    expect(chrome.supported && chrome.gpu).toMatchObject({
      memoryBudgetMB: 4096,
      memorySource: 'device-memory',
      deviceMemoryGiB: 8,
      shaderF16: true,
      lowResource: false,
      maxBufferSize: 4 * GiB,
    })
    const safari = await detectLocalSupport({ gpu: fakeGpu({ shaderF16: false }) })
    expect(safari.supported && safari.gpu).toMatchObject({
      memoryBudgetMB: 2048,
      memorySource: 'default',
      deviceMemoryGiB: null,
      shaderF16: false,
    })
  })

  test('storage bindings under 1 GiB restrict to low-resource builds', async () => {
    const d = await detectLocalSupport({ gpu: fakeGpu({ maxStorageBufferBindingSize: 512 * MiB }) })
    expect(d.supported && d.gpu.lowResource).toBe(true)
  })
})

describe('space check', () => {
  test('refuses when the browser gives no estimate', () => {
    expect(checkSpace(null, 100, 0)).toEqual({ ok: false, reason: 'unknown' })
    expect(checkSpace({ usage: 0 }, 100, 0)).toEqual({ ok: false, reason: 'unknown' })
  })

  test('keeps at least 1 GiB free for the library after the download', () => {
    const quota = 4 * GiB
    expect(checkSpace({ usage: 0, quota }, 3 * GiB, 0)).toEqual({
      ok: true,
      needBytes: 3 * GiB,
      freeBytes: quota,
      reserveBytes: LIBRARY_RESERVE_MIN_BYTES,
    })
    expect(checkSpace({ usage: 0, quota }, 3 * GiB + 1, 0)).toMatchObject({ ok: false, reason: 'not-enough-space' })
  })

  test('a large library keeps room to double', () => {
    const library = 3 * GiB
    const verdict = checkSpace({ usage: library, quota: 8 * GiB }, 2 * GiB + 1, 0)
    expect(verdict).toEqual({
      ok: false,
      reason: 'not-enough-space',
      needBytes: 2 * GiB + 1,
      freeBytes: 5 * GiB,
      reserveBytes: library,
    })
    expect(checkSpace({ usage: library, quota: 8 * GiB }, 2 * GiB, 0).ok).toBe(true)
  })

  test('bytes of the model already cached are not counted as library', () => {
    // 2 GiB used, of which 1.5 GiB is the half-downloaded model: the library is 0.5 GiB, the floor applies.
    const verdict = checkSpace({ usage: 2 * GiB, quota: 4 * GiB }, GiB, 1.5 * GiB)
    expect(verdict).toEqual({ ok: true, needBytes: GiB, freeBytes: 2 * GiB, reserveBytes: GiB })
  })
})

describe('weight cache', () => {
  test('model URLs follow WebLLM: <repo>/resolve/main/, the library by file name', () => {
    expect(QWEN).toEqual({
      modelUrl: 'https://huggingface.co/mlc-ai/Qwen3.5-2B-q4f16_1-MLC/resolve/main/',
      libFile: 'Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm',
    })
    expect(modelFiles('https://h/x/resolve/v2/', 'lib.wasm').modelUrl).toBe('https://h/x/resolve/v2/')
  })

  test('cache names carry the cursus- prefix', () => {
    expect(cacheName(WEBLLM_SCOPES.model)).toBe('cursus-webllm/model')
  })

  test('nothing cached: not complete, size unknown, and no cache gets created', async () => {
    const caches = memoryCaches()
    expect(await modelCacheState(caches, QWEN)).toEqual({ complete: false, cachedBytes: 0, totalBytes: null })
    expect(caches.names()).toEqual([])
  })

  test('a stopped download resumes, then the model is complete; remove deletes only its files', async () => {
    const caches = memoryCaches()
    const stop = new AbortController()
    const engine = fakeLocalEngine({
      models: [target.id],
      caches,
      beforeShard: async (i) => {
        if (i === 2) stop.abort()
      },
    })
    await expect(engine.load(target, () => {}, stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await modelCacheState(caches, QWEN)).toEqual({ complete: false, cachedBytes: 2 * MiB, totalBytes: 4 * MiB })

    const progress: number[] = []
    await fakeLocalEngine({ models: [target.id], caches }).load(target, (p) => progress.push(p.fraction))
    expect(progress).toEqual([0.25, 0.5, 0.75, 1])
    expect(await modelCacheState(caches, QWEN)).toEqual({ complete: true, cachedBytes: 4 * MiB, totalBytes: 4 * MiB })
    expect(caches.names().every((n) => n.startsWith(CACHE_PREFIX))).toBe(true)

    const other = {
      id: 'Qwen3-0.6B-q4f16_1-MLC',
      files: modelFiles('https://huggingface.co/mlc-ai/Qwen3-0.6B', 'q.wasm'),
    }
    await fakeLocalEngine({ models: [other.id], caches }).load(other, () => {})
    expect(await removeModelFiles(caches, QWEN)).toBe(8) // json, 4 shards, tokenizer, config, library
    expect(await modelCacheState(caches, QWEN)).toEqual({ complete: false, cachedBytes: 0, totalBytes: null })
    expect((await modelCacheState(caches, other.files)).complete).toBe(true)
  })

  test('weights without the library or tokenizer are not complete', async () => {
    const caches = memoryCaches()
    await fakeLocalEngine({ models: [target.id], caches }).load(target, () => {})
    const wasm = await caches.open(cacheName(WEBLLM_SCOPES.wasm))
    for (const { url } of await wasm.keys()) await wasm.delete(url)
    expect(await modelCacheState(caches, QWEN)).toMatchObject({ complete: false, cachedBytes: 4 * MiB })
  })

  test('a malformed shard list is an error, not an empty cache', async () => {
    const caches = memoryCaches()
    const model = await caches.open(cacheName(WEBLLM_SCOPES.model))
    await model.put(`${QWEN.modelUrl}tensor-cache.json`, new Response('{"records":[{"dataPath":1}]}'))
    await expect(modelCacheState(caches, QWEN)).rejects.toBeInstanceOf(LocalModelError)
  })

  test('prefixedCaches gives WebLLM its own names under cursus-', async () => {
    const inner = new Map<string, string>()
    const named = {
      open: async (name: string) => {
        inner.set(name, name)
        return { match: async (request: string) => (request === `hit:${name}` ? name : undefined) }
      },
      has: async (name: string) => inner.has(name),
      delete: async (name: string) => inner.delete(name),
      keys: async () => [...inner.keys()],
    }
    inner.set('other-app', 'other-app')
    const caches = prefixedCaches(named)
    await caches.open('webllm/model')
    expect([...inner.keys()]).toEqual(['other-app', 'cursus-webllm/model'])
    expect(await caches.has('webllm/model')).toBe(true)
    expect(await caches.keys()).toEqual(['webllm/model'])
    expect(await caches.match('hit:cursus-webllm/model')).toBe('cursus-webllm/model')
    expect(await caches.match('hit:other-app')).toBeUndefined()
    expect(await caches.delete('webllm/model')).toBe(true)
    expect([...inner.keys()]).toEqual(['other-app'])
  })
})

/** The page and the worker joined by a MessageChannel, as `new Worker` would. */
function workerPair(backend: EngineBackend) {
  const { port1, port2 } = new MessageChannel()
  const errors: ((e: WorkerEvent) => void)[] = []
  const sent: string[] = []
  let terminated = false
  serveLocalEngine(
    {
      postMessage: (m) => port2.postMessage(m),
      addEventListener: (_type, listener) => {
        port2.addEventListener('message', (e) => listener({ data: e.data }))
        port2.start()
      },
    },
    backend,
  )
  const worker: WorkerLike = {
    postMessage: (m) => {
      sent.push(m.op)
      port1.postMessage(m)
    },
    addEventListener: (type, listener) => {
      if (type === 'error') errors.push(listener)
      else {
        port1.addEventListener('message', (e) => listener({ data: e.data }))
        port1.start()
      }
    },
    terminate: () => {
      terminated = true
      port1.close()
      port2.close()
    },
  }
  return {
    engine: connectWorkerEngine(worker),
    sent,
    crash: (message: string) => {
      for (const l of errors) l({ message })
    },
    terminated: () => terminated,
  }
}

const schema = z.object({ answer: z.string(), n: z.number() })

describe('worker protocol', () => {
  test('lists models and forwards load progress', async () => {
    const { engine } = workerPair({
      models: () => ['a', 'b'],
      load: async (_id, onProgress) => {
        onProgress({ fraction: 0.5, text: 'half' })
        onProgress({ fraction: 1, text: 'done' })
      },
      model: () => jsonModel({}),
    })
    expect(await engine.models()).toEqual(['a', 'b'])
    const seen: LoadProgress[] = []
    await engine.load(target, (p) => seen.push(p))
    expect(seen).toEqual([
      { fraction: 0.5, text: 'half' },
      { fraction: 1, text: 'done' },
    ])
  })

  test('structured output goes through generateText and streamText, provider options merged', async () => {
    const generate = jsonModel({ answer: 'yes', n: 2 }, 30, 7)
    const stream = streamModel(['{"answer":"he', 'llo","n":', '7}'])
    let next = generate
    const { engine } = workerPair({ models: () => [], load: async () => {}, model: () => next })
    const model = engine.languageModel('m', { 'web-llm': { extra_body: { enable_thinking: false } } })
    const res = await generateText({ model, prompt: 'P', output: Output.object({ schema }) })
    expect(res.output).toEqual({ answer: 'yes', n: 2 })
    expect(res.totalUsage.inputTokens).toBe(30)
    expect(generate.doGenerateCalls[0]?.responseFormat?.type).toBe('json')
    expect(generate.doGenerateCalls[0]?.providerOptions).toEqual({
      'web-llm': { extra_body: { enable_thinking: false } },
    })

    next = stream
    const s = streamText({ model, prompt: 'P', output: Output.object({ schema }) })
    const partials: unknown[] = []
    for await (const p of s.partialOutputStream) partials.push(p)
    expect(partials[0]).toEqual({ answer: 'he' })
    expect(await s.output).toEqual({ answer: 'hello', n: 7 })
  })

  test('engine errors come back with their code', async () => {
    const { engine } = workerPair({
      models: () => [],
      load: async () => {
        throw new LocalModelError('unsupported-model', 'nope')
      },
      model: () => {
        throw new LocalModelError('engine', 'not loaded')
      },
    })
    await expect(engine.load(target, () => {})).rejects.toMatchObject({ code: 'unsupported-model', message: 'nope' })
    await expect(generateText({ model: engine.languageModel('m'), prompt: 'P', maxRetries: 0 })).rejects.toThrow(
      'not loaded',
    )
  })

  test('aborting a call tells the worker to interrupt', async () => {
    let release = () => {}
    const slow = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) => {
        await new Promise<void>((resolve) => {
          release = resolve
          abortSignal?.addEventListener('abort', () => resolve())
        })
        return {
          content: [{ type: 'text', text: '{}' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        }
      },
    })
    const { engine, sent } = workerPair({ models: () => [], load: async () => {}, model: () => slow })
    const controller = new AbortController()
    const call = engine.languageModel('m').doGenerate({ prompt: [], abortSignal: controller.signal })
    await Bun.sleep(5)
    controller.abort()
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    await Bun.sleep(5)
    expect(sent).toEqual(['generate', 'abort'])
    release()
  })

  test('aborting a load stops the worker; a crashed worker fails what was pending', async () => {
    const hang = workerPair({ models: () => [], load: () => new Promise(() => {}), model: () => jsonModel({}) })
    const controller = new AbortController()
    const load = hang.engine.load(target, () => {}, controller.signal)
    controller.abort()
    await expect(load).rejects.toMatchObject({ name: 'AbortError' })
    expect(hang.terminated()).toBe(true)
    await expect(hang.engine.models()).rejects.toMatchObject({ code: 'engine' })

    const crash = workerPair({ models: () => [], load: () => new Promise(() => {}), model: () => jsonModel({}) })
    const pending = crash.engine.load(target, () => {})
    crash.crash('out of memory')
    await expect(pending).rejects.toMatchObject({ code: 'engine', message: 'out of memory' })
  })
})

describe('fake engine', () => {
  test('answers the smallest JSON the schema accepts, after a load only', async () => {
    const engine = fakeLocalEngine({ models: ['m'] })
    const model = engine.languageModel('m')
    await expect(generateText({ model, prompt: 'P', maxRetries: 0 })).rejects.toThrow('not loaded')
    await engine.load({ id: 'm', files: QWEN }, () => {})
    const res = await generateText({ model, prompt: 'P', output: Output.object({ schema }) })
    expect(res.output).toEqual({ answer: 'x', n: 0 })
    expect(engine.calls).toHaveLength(1)
    await expect(engine.load({ id: 'other', files: QWEN }, () => {})).rejects.toMatchObject({
      code: 'unsupported-model',
    })
  })

  test('sampleJson covers what the feature schemas use', () => {
    const s = z.toJSONSchema(
      z.object({
        kind: z.enum(['a', 'b']),
        items: z.array(z.object({ t: z.string() })).min(1),
        opt: z.string().optional(),
        flag: z.boolean(),
        either: z.union([z.number(), z.string()]),
      }),
    )
    expect(sampleJson(s)).toEqual({ kind: 'a', items: [{ t: 'x' }], flag: false, either: 0 })
  })
})
