import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { CatalogProvider } from './catalogTrim'
import { AiConfigError, createModel, generateStructured, outputLanguage, streamStructured } from './client'
import { ctxFor, jsonModel, streamModel } from './testkit.test'
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

  test('output language: course first, then UI', () => {
    expect(outputLanguage('de', 'fr')).toBe('German')
    expect(outputLanguage(undefined, 'fr')).toBe('French')
    expect(outputLanguage('  ', 'en')).toBe('English')
    expect(outputLanguage('es', 'en')).toBe('es')
  })
})
