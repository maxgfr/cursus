import { expect, test } from 'bun:test'
import { z } from 'zod'
import { bundledCatalog, findModel, findProvider } from '../../src/core/ai/catalog'
import { createModel, generateStructured } from '../../src/core/ai/client'
import type { AiUsageEvent } from '../../src/core/ai/usage'

// One real AI provider, called the way the app calls it (structured output, usage recorded).
const VARS = ['LIVE_AI_PROVIDER', 'LIVE_AI_MODEL', 'LIVE_AI_KEY']
const missing = VARS.filter((v) => !process.env[v])
const env = (name: string): string => process.env[name] ?? ''

if (missing.length > 0) {
  test.skip(`live AI: skipped, set ${missing.join(', ')}`, () => {})
} else {
  test(`live AI: ${env('LIVE_AI_PROVIDER')}/${env('LIVE_AI_MODEL')} returns structured output and usage`, async () => {
    const catalog = bundledCatalog()
    const provider = findProvider(catalog, env('LIVE_AI_PROVIDER'))
    const info = findModel(catalog, env('LIVE_AI_PROVIDER'), env('LIVE_AI_MODEL'))
    if (!provider || !info) throw new Error('LIVE_AI_PROVIDER / LIVE_AI_MODEL not found in the bundled catalog')
    const model = await createModel({ provider, modelId: env('LIVE_AI_MODEL'), apiKey: env('LIVE_AI_KEY') })
    const usage: AiUsageEvent[] = []
    const out = await generateStructured(
      { model, info, language: 'English', onUsage: (e) => usage.push(e) },
      {
        feature: 'quiz',
        system: 'Answer with the requested JSON only.',
        prompt: 'What is 2 + 3? Give the number as `answer`.',
        schema: z.object({ answer: z.number() }),
      },
    )
    expect(out.answer).toBe(5)
    expect(usage).toHaveLength(1)
  }, 60_000)
}
