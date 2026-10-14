import { expect, test } from 'bun:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CatalogModel } from './catalogTrim'
import type { FeatureCtx } from './client'
import type { AiUsageEvent } from './usage'

export const INFO: CatalogModel = {
  id: 'mock-1',
  name: 'Mock 1',
  provider: 'mockai',
  context_length: 8000,
  cost: { input: 2, output: 10 },
  modalities: { input: ['text'] },
  capabilities: { structured_output: true },
}

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
})

export function jsonModel(value: unknown, input = 100, output = 50): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: usage(input, output),
      warnings: [],
    },
  })
}

export function streamModel(deltas: string[], input = 10, output = 5): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't' },
          ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
          { type: 'text-end' as const, id: 't' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: usage(input, output),
          },
        ],
      }),
    },
  })
}

export function ctxFor(model: MockLanguageModelV4, events: AiUsageEvent[] = [], language = 'French'): FeatureCtx {
  return { model, info: INFO, language, onUsage: (e) => events.push(e), now: () => 1_700_000_000_000 }
}

/** Text of the system and user messages of the first generate call. */
export function sentPrompt(model: MockLanguageModelV4): { system: string; user: string } {
  const call = model.doGenerateCalls[0]
  if (!call) throw new Error('model was not called')
  let system = ''
  let user = ''
  for (const m of call.prompt) {
    if (m.role === 'system') system += m.content
    if (m.role === 'user') for (const p of m.content) if (p.type === 'text') user += p.text
  }
  return { system, user }
}

test('testkit mock model answers JSON', () => {
  expect(jsonModel({ a: 1 }).doGenerateCalls).toEqual([])
})
