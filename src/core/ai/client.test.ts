import { describe, expect, test } from 'bun:test'
import { NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import type { CatalogProvider } from './catalogTrim'
import { AiConfigError, createModel, generateStructured, outputLanguage, streamStructured } from './client'
import { type AiEffort, effortLevels } from './effort'
import { fakeGpu, fakeLocalEngine, LOCAL_PROVIDER, LOCAL_PROVIDER_INFO } from './local'
import { memoryCaches } from './localkit.test'
import { configureLocalModels, findLocalModel, localModelInfo, localModels } from './localModels'
import { brokenModel, ctxFor, jsonModel, streamModel } from './testkit.test'
import type { AiUsageEvent } from './usage'

const schema = z.object({ answer: z.string(), n: z.number() })
const provider = (id: string, extra: Partial<CatalogProvider> = {}): CatalogProvider => ({
  id,
  name: id,
  api: null,
  baseUrlSource: 'none',
  kind: 'vendor',
  browser: { verdict: 'callable', evidence: 'preflight', checkedAt: '2026-10-14T00:00:00.000Z' },
  ...extra,
})

describe('client', () => {
  test('generateStructured parses the object and records usage', async () => {
    const events: AiUsageEvent[] = []
    const model = jsonModel({ answer: 'yes', n: 2 }, 1000, 100)
    const out = await generateStructured(ctxFor(model, events), { feature: 'quiz', system: 'S', prompt: 'P', schema })
    expect(out).toEqual({ answer: 'yes', n: 2 })
    expect(model.doGenerateCalls[0]?.responseFormat?.type).toBe('json')
    expect(events).toEqual([
      {
        at: 1_700_000_000_000,
        feature: 'quiz',
        provider: 'mockai',
        model: 'mock-1',
        inputTokens: 1000,
        outputTokens: 100,
        cost: 0.003,
      },
    ])
  })

  test('generateStructured rejects output that violates the schema', async () => {
    const model = jsonModel({ answer: 3 })
    await expect(
      generateStructured(ctxFor(model), { feature: 'quiz', system: 'S', prompt: 'P', schema }),
    ).rejects.toThrow()
  })

  test('a refused answer (truncated or invalid JSON, or off-schema) is still billed and reported', async () => {
    for (const [text, inTok, outTok] of [
      ['{"answer": "trunc', 1000, 100],
      ['{"answer": 3, "n": "x"}', 400, 40],
    ] as const) {
      const events: AiUsageEvent[] = []
      const run = generateStructured(ctxFor(brokenModel(text, inTok, outTok), events), {
        feature: 'quiz',
        system: 'S',
        prompt: 'P',
        schema,
      })
      await expect(run).rejects.toBeInstanceOf(NoObjectGeneratedError)
      expect(events).toEqual([
        expect.objectContaining({
          feature: 'quiz',
          inputTokens: inTok,
          outputTokens: outTok,
          cost: expect.any(Number),
        }),
      ])
      expect(events[0]?.cost).toBeGreaterThan(0)
    }
  })

  test('a streamed answer that does not parse is still billed and reported', async () => {
    const events: AiUsageEvent[] = []
    const s = streamStructured(ctxFor(streamModel(['{"answer":"he', 'llo"'], 30, 20), events), {
      feature: 'understand',
      system: 'S',
      prompt: 'P',
      schema,
    })
    for await (const _ of s.partial) {
      // drained
    }
    await expect(s.output).rejects.toBeInstanceOf(NoObjectGeneratedError)
    expect(events).toEqual([expect.objectContaining({ feature: 'understand', inputTokens: 30, outputTokens: 20 })])
  })

  test('streamStructured yields partial objects then the full one', async () => {
    const events: AiUsageEvent[] = []
    const model = streamModel(['{"answer":"he', 'llo","n":', '7}'])
    const s = streamStructured(ctxFor(model, events), { feature: 'understand', system: 'S', prompt: 'P', schema })
    const partials: unknown[] = []
    for await (const p of s.partial) partials.push(p)
    expect(partials.length).toBeGreaterThan(1)
    expect(partials[0]).toEqual({ answer: 'he' })
    expect(await s.output).toEqual({ answer: 'hello', n: 7 })
    expect(events).toHaveLength(1)
    expect(events[0]?.inputTokens).toBe(10)
  })

  test('with onPartial, generateStructured streams: partials as they come, the same result and usage', async () => {
    const events: AiUsageEvent[] = []
    const partials: unknown[] = []
    const model = streamModel(['{"answer":"he', 'llo","n":', '7}'], 12, 6)
    const out = await generateStructured(
      { ...ctxFor(model, events), onPartial: (p) => partials.push(p) },
      { feature: 'quiz', system: 'S', prompt: 'P', schema },
    )
    expect(out).toEqual({ answer: 'hello', n: 7 })
    expect(partials[0]).toEqual({ answer: 'he' })
    expect(partials.length).toBeGreaterThan(1)
    expect(model.doStreamCalls).toHaveLength(1)
    expect(events).toEqual([expect.objectContaining({ feature: 'quiz', inputTokens: 12, outputTokens: 6 })])
  })

  test('with onPartial, an answer that does not parse is refused and still billed', async () => {
    const events: AiUsageEvent[] = []
    const ctx = { ...ctxFor(streamModel(['{"answer":"he', 'llo"'], 30, 20), events), onPartial: () => {} }
    await expect(generateStructured(ctx, { feature: 'quiz', system: 'S', prompt: 'P', schema })).rejects.toBeInstanceOf(
      NoObjectGeneratedError,
    )
    expect(events).toEqual([expect.objectContaining({ feature: 'quiz', inputTokens: 30, outputTokens: 20 })])
  })

  test('createModel loads each provider package lazily', async () => {
    const anthropic = await createModel({ provider: provider('anthropic'), modelId: 'claude-x', apiKey: 'k' })
    const google = await createModel({ provider: provider('google'), modelId: 'gemini-x', apiKey: 'k' })
    const openai = await createModel({ provider: provider('openai'), modelId: 'gpt-x', apiKey: 'k' })
    const openrouter = await createModel({ provider: provider('openrouter'), modelId: 'a/b', apiKey: 'k' })
    const compat = await createModel({
      provider: provider('groq', { api: 'https://api.groq.com/openai/v1', baseUrlSource: 'default' }),
      modelId: 'llama',
      apiKey: 'k',
    })
    for (const [m, id] of [
      [anthropic, 'claude-x'],
      [google, 'gemini-x'],
      [openai, 'gpt-x'],
      [openrouter, 'a/b'],
      [compat, 'llama'],
    ] as const) {
      expect(typeof m === 'object' && m.modelId).toBe(id)
    }
    expect(typeof compat === 'object' && compat.provider).toContain('groq')
  })

  test('createModel refuses providers a browser cannot reach or without a URL', async () => {
    await expect(
      createModel({
        provider: provider('x', {
          api: 'https://x/v1',
          browser: { verdict: 'blocked', evidence: 'preflight', checkedAt: '2026-10-14T00:00:00.000Z' },
        }),
        modelId: 'm',
        apiKey: 'k',
      }),
    ).rejects.toBeInstanceOf(AiConfigError)
    await expect(createModel({ provider: provider('nowhere'), modelId: 'm', apiKey: 'k' })).rejects.toBeInstanceOf(
      AiConfigError,
    )
  })

  test('the Anthropic browser header goes to Anthropic only, not to servers speaking its protocol', async () => {
    const { generateText } = await import('ai')
    const sent: { url: string; header: string | null }[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(input),
        header: new Headers(init?.headers).get('anthropic-dangerous-direct-browser-access'),
      })
      return new Response('{}', { status: 400 })
    }) as typeof fetch
    try {
      const minimax = provider('minimax', { npm: '@ai-sdk/anthropic', api: 'https://api.minimax.io/anthropic/v1' })
      for (const p of [provider('anthropic'), minimax]) {
        const model = await createModel({ provider: p, modelId: 'm', apiKey: 'k' })
        await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow()
      }
    } finally {
      globalThis.fetch = real
    }
    expect(sent).toEqual([
      { url: 'https://api.anthropic.com/v1/messages', header: 'true' },
      { url: 'https://api.minimax.io/anthropic/v1/messages', header: null },
    ])
  })

  const effortOf = (body: Record<string, unknown>) => (body.output_config as { effort?: string } | undefined)?.effort

  /** The JSON body of the first request a call through `ref` sends; the fake server then refuses it. */
  async function sentBody(ref: Parameters<typeof createModel>[0]): Promise<Record<string, unknown>> {
    const { generateText } = await import('ai')
    const bodies: Record<string, unknown>[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('{}', { status: 400 })
    }) as typeof fetch
    try {
      const model = await createModel(ref)
      await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow()
    } finally {
      globalThis.fetch = real
    }
    const [body] = bodies
    if (!body) throw new Error('no request sent')
    return body
  }

  /** Every level the model takes, each with the body its request carries. */
  async function bodiesByLevel(providerId: string, modelId: string): Promise<[AiEffort, Record<string, unknown>][]> {
    const levels = effortLevels(providerId, modelId)
    expect(levels.length).toBeGreaterThan(1)
    const ref = { provider: provider(providerId, { api: null }), modelId, apiKey: 'k' }
    // One at a time: each call swaps the global fetch.
    const out: [AiEffort, Record<string, unknown>][] = []
    for (const effort of levels) out.push([effort, await sentBody({ ...ref, effort })])
    return out
  }
  const thinkingConfig = (body: Record<string, unknown>) =>
    (body.generationConfig as { thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number } }).thinkingConfig

  test('each level a Claude model takes goes out as its effort, or as a thinking budget before Claude 4.6', async () => {
    for (const modelId of ['claude-opus-5-5', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101']) {
      for (const [effort, body] of await bodiesByLevel('anthropic', modelId)) {
        if (modelId.startsWith('claude-opus-4-5')) {
          expect(body.thinking).toMatchObject({ type: 'enabled' })
          expect(effortOf(body)).toBeUndefined()
        } else {
          expect(effortOf(body)).toBe(effort)
          expect(body.thinking).toMatchObject({ type: 'adaptive' })
        }
      }
    }
    // A budget grows with the level.
    const budgets = (await bodiesByLevel('anthropic', 'claude-sonnet-4-5')).map(
      ([, body]) => (body.thinking as { budget_tokens: number }).budget_tokens,
    )
    expect(budgets).toEqual([...budgets].sort((a, b) => a - b))
    expect(new Set(budgets).size).toBe(budgets.length)
  })

  test('each level an OpenAI model takes goes out as its reasoning effort', async () => {
    for (const modelId of ['gpt-5', 'gpt-5.1', 'gpt-5.4', 'gpt-5.5-pro', 'gpt-5.6', 'gpt-6.1-sol', 'o3']) {
      for (const [effort, body] of await bodiesByLevel('openai', modelId)) {
        expect(body.reasoning).toMatchObject({ effort })
      }
    }
  })

  test('each level a Gemini model takes goes out as its thinking level, or a budget on 2.5', async () => {
    for (const modelId of [
      'gemini-4-argon',
      'gemini-3-pro-preview',
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.8-flash',
    ]) {
      for (const [effort, body] of await bodiesByLevel('google', modelId)) {
        expect(thinkingConfig(body)?.thinkingLevel).toBe(effort)
      }
    }
    const budgets = (await bodiesByLevel('google', 'gemini-2.5-flash')).map(
      ([, body]) => thinkingConfig(body)?.thinkingBudget,
    )
    expect(budgets.every((b) => typeof b === 'number' && b > 0)).toBe(true)
    expect(new Set(budgets).size).toBe(budgets.length)
  })

  test('each level goes to OpenRouter as its reasoning effort, which it maps for the maker', async () => {
    for (const modelId of ['anthropic/claude-opus-4.6', 'openai/gpt-5.6', 'google/gemini-3-pro-preview']) {
      for (const [effort, body] of await bodiesByLevel('openrouter', modelId)) {
        expect(body.reasoning).toEqual({ effort })
      }
    }
  })

  test('a level the model does not take is never sent', async () => {
    const at = (id: string) => provider(id, { api: null })
    const opus46 = await sentBody({
      provider: at('anthropic'),
      modelId: 'claude-opus-4-6',
      apiKey: 'k',
      effort: 'xhigh',
    })
    expect(effortOf(opus46)).toBeUndefined()
    expect(opus46.thinking).toBeUndefined()
    const pro = await sentBody({
      provider: at('google'),
      modelId: 'gemini-3-pro-preview',
      apiKey: 'k',
      effort: 'medium',
    })
    expect(thinkingConfig(pro)).toBeUndefined()
    const gpt5 = await sentBody({ provider: at('openai'), modelId: 'gpt-5', apiKey: 'k', effort: 'none' })
    expect(gpt5.reasoning).toBeUndefined()
    const routed = await sentBody({ provider: at('openrouter'), modelId: 'openai/gpt-5.6', apiKey: 'k', effort: 'max' })
    expect(routed.reasoning).toBeUndefined()
    const unknown = await sentBody({ provider: at('openai'), modelId: 'gpt-4o', apiKey: 'k', effort: 'high' })
    expect(unknown.reasoning).toBeUndefined()
  })

  test('without an effort, or through a provider that does not take one, nothing is sent', async () => {
    const at = (id: string) => provider(id, { api: null })
    const anthropic = await sentBody({ provider: at('anthropic'), modelId: 'claude-opus-5', apiKey: 'k' })
    expect(effortOf(anthropic)).toBeUndefined()
    expect(anthropic.thinking).toBeUndefined()
    const openai = await sentBody({ provider: at('openai'), modelId: 'gpt-5', apiKey: 'k' })
    expect(openai.reasoning).toBeUndefined()
    const google = await sentBody({ provider: at('google'), modelId: 'gemini-3-pro-preview', apiKey: 'k' })
    expect(google.generationConfig).not.toHaveProperty('thinkingConfig')
    const openrouter = await sentBody({ provider: at('openrouter'), modelId: 'a/b', apiKey: 'k' })
    expect(openrouter.reasoning).toBeUndefined()
    // A server speaking a known protocol may refuse a parameter it does not know: it never gets one.
    const groq = provider('groq', { api: 'https://api.groq.com/openai/v1', baseUrlSource: 'default' })
    const compat = await sentBody({ provider: groq, modelId: 'qwen3', apiKey: 'k', effort: 'high' })
    expect(compat.reasoning_effort).toBeUndefined()
    const minimax = provider('minimax', { npm: '@ai-sdk/anthropic', api: 'https://api.minimax.io/anthropic/v1' })
    const viaAnthropic = await sentBody({ provider: minimax, modelId: 'MiniMax-M2', apiKey: 'k', effort: 'high' })
    expect(effortOf(viaAnthropic)).toBeUndefined()
    expect(viaAnthropic.thinking).toBeUndefined()
  })

  test('the on-device model is keyless, refused until downloaded, and free', async () => {
    const id = 'Qwen3-1.7B-q4f16_1-MLC'
    const caches = memoryCaches()
    configureLocalModels({
      env: () => ({ gpu: fakeGpu() }),
      engine: () => fakeLocalEngine({ models: [id], caches }),
      storage: { estimate: async () => ({ usage: 0, quota: 2 ** 40 }) },
      caches,
    })
    try {
      const ref = { provider: LOCAL_PROVIDER_INFO, modelId: id, apiKey: '' }
      await expect(createModel(ref)).rejects.toMatchObject({ code: 'not-downloaded' })
      const described = findLocalModel(id)
      if (!described) throw new Error(`${id} is missing from llm-models`)
      await localModels().handle(described).download()
      const events: AiUsageEvent[] = []
      const out = await generateStructured(
        {
          model: await createModel(ref),
          info: localModelInfo(described),
          language: 'English',
          onUsage: (e) => events.push(e),
        },
        { feature: 'quiz', system: 'S', prompt: 'P', schema },
      )
      expect(out).toEqual({ answer: 'x', n: 0 })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ provider: LOCAL_PROVIDER, model: id, cost: 0 })
      expect(events[0]?.inputTokens).toBeGreaterThan(0)
    } finally {
      configureLocalModels(null)
    }
  })

  test('output language: course first, then UI', () => {
    expect(outputLanguage('de', 'fr')).toBe('German')
    expect(outputLanguage(undefined, 'fr')).toBe('French')
    expect(outputLanguage('  ', 'en')).toBe('English')
    expect(outputLanguage('es', 'en')).toBe('Spanish')
    // A code without a name is passed as is.
    expect(outputLanguage('ja', 'en')).toBe('ja')
  })
})
