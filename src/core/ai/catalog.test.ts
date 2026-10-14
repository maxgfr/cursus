import { describe, expect, test } from 'bun:test'
import { bundledCatalog, callableModels, findModel, MODELS_DEV_URL, refreshCatalog } from './catalog'
import { type Catalog, fromModelsDev, keepProvider, providerBaseUrl, trimModel, trimProvider } from './catalogTrim'

const FIXTURE = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    npm: '@ai-sdk/openai',
    models: {
      'gpt-x': {
        id: 'gpt-x',
        name: 'GPT X',
        release_date: '2026-01-01',
        tool_call: true,
        structured_output: true,
        reasoning: false,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 1, output: 4, cache_read: 0.1 },
        limit: { context: 400000, output: 128000 },
        knowledge: '2025-06',
      },
      broken: { id: 'broken' },
    },
  },
  bedrock: { id: 'bedrock', name: 'Bedrock', npm: '@ai-sdk/amazon-bedrock', models: {} },
  tiny: {
    id: 'tiny',
    name: 'Tiny',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://tiny.example/v1',
    models: { t1: { id: 't1', name: 'T1', limit: { context: 1000 }, status: 'deprecated' } },
  },
  garbage: 42,
}

const PREVIOUS: Catalog = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  providers: [{ id: 'openai', name: 'OpenAI', api: null, browserCallable: true, models: [] }],
}

describe('catalogTrim', () => {
  test('keeps supported npm, an api, or a known base URL', () => {
    expect(keepProvider({ id: 'a', name: 'A', npm: '@ai-sdk/anthropic', models: [] })).toBe(true)
    expect(keepProvider({ id: 'b', name: 'B', npm: 'other', api: 'https://b', models: [] })).toBe(true)
    expect(keepProvider({ id: 'mistral', name: 'M', npm: '@ai-sdk/mistral', models: [] })).toBe(true)
    expect(keepProvider({ id: 'bedrock', name: 'B', npm: '@ai-sdk/amazon-bedrock', models: [] })).toBe(false)
  })

  test('reduces a model to the documented fields and strips the provider prefix', () => {
    const m = trimModel({
      id: 'groq/llama',
      name: 'Llama',
      provider: 'groq',
      context_length: 1000,
      cost: { input: 1, output: 2 },
      modalities: { input: ['text'] },
      capabilities: { reasoning: false, tool_call: true },
      release_date: '2025-01-01',
    })
    expect(m).toEqual({
      id: 'llama',
      name: 'Llama',
      provider: 'groq',
      context_length: 1000,
      cost: { input: 1, output: 2 },
      modalities: { input: ['text'] },
      capabilities: { tool_call: true },
      release_date: '2025-01-01',
    })
  })

  test('normalizes models.dev, skipping malformed entries and deprecated models', () => {
    const ps = fromModelsDev(FIXTURE)
    expect(ps.map((p) => p.id)).toEqual(['openai', 'bedrock', 'tiny'])
    const openai = trimProvider(ps[0] ?? { id: '', name: '', models: [] }, true)
    expect(openai.models).toHaveLength(1)
    expect(openai.models[0]?.cost).toEqual({ input: 1, output: 4 })
    expect(openai.models[0]?.output_limit).toBe(128000)
    expect(trimProvider(ps[2] ?? { id: '', name: '', models: [] }, true).models).toEqual([])
    expect(() => fromModelsDev([1, 2])).toThrow()
  })

  test('base URL: provider api first, in-house table otherwise', () => {
    expect(providerBaseUrl({ id: 'x', api: 'https://x/v1' })).toBe('https://x/v1')
    expect(providerBaseUrl({ id: 'anthropic', api: null })).toBe('https://api.anthropic.com/v1')
    expect(providerBaseUrl({ id: 'unknown', api: null })).toBeNull()
  })
})

describe('catalog', () => {
  test('bundled catalog fits the budget and is well formed', async () => {
    const size = (await Bun.file(new URL('./catalog.json', import.meta.url)).arrayBuffer()).byteLength
    expect(size).toBeLessThanOrEqual(300 * 1024)
    const c = bundledCatalog()
    expect(c.providers.length).toBeGreaterThan(0)
    for (const p of c.providers) {
      expect(typeof p.browserCallable).toBe('boolean')
      if (!p.browserCallable) expect(p.models).toEqual([])
    }
    expect(callableModels(c).length).toBeGreaterThan(0)
  })

  test('refreshCatalog GETs models.dev and keeps known browserCallable', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(FIXTURE))
    }) as typeof fetch
    const c = await refreshCatalog(PREVIOUS, fake, () => 0)
    expect(calls).toEqual([{ url: MODELS_DEV_URL, init: undefined }])
    expect(c.generatedAt).toBe('1970-01-01T00:00:00.000Z')
    expect(c.providers.map((p) => p.id)).toEqual(['openai', 'tiny'])
    expect(findModel(c, 'openai', 'gpt-x')?.context_length).toBe(400000)
    expect(c.providers.find((p) => p.id === 'tiny')?.browserCallable).toBe(false)
  })

  test('refreshCatalog surfaces HTTP failures', async () => {
    const fake = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch
    await expect(refreshCatalog(PREVIOUS, fake)).rejects.toThrow('503')
  })
})
