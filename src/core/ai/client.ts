import { type DeepPartial, generateText, type LanguageModel, Output, streamText } from 'ai'
import type { z } from 'zod'
import type { CatalogModel, CatalogProvider } from './catalogTrim'
import { providerBaseUrl } from './catalogTrim'
import type { TokenUsage } from './cost'
import { type AiFeature, type UsageSink, usageEvent } from './usage'

export class AiConfigError extends Error {}

export interface ModelRef {
  provider: CatalogProvider
  modelId: string
  apiKey: string
}

/** Builds a language model; provider packages are loaded only when first needed. */
export async function createModel(ref: ModelRef): Promise<LanguageModel> {
  const { provider, modelId, apiKey } = ref
  if (!provider.browserCallable) throw new AiConfigError(`${provider.id} cannot be called from a browser`)
  if (provider.id === 'anthropic' || provider.npm === '@ai-sdk/anthropic') {
    const { createAnthropic } = await import('@ai-sdk/anthropic')
    return createAnthropic({
      apiKey,
      baseURL: provider.api ?? undefined,
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    })(modelId)
  }
  if (provider.id === 'google' || provider.npm === '@ai-sdk/google') {
    const { createGoogle } = await import('@ai-sdk/google')
    return createGoogle({ apiKey, baseURL: provider.api ?? undefined })(modelId)
  }
  if (provider.id === 'openai' || provider.npm === '@ai-sdk/openai') {
    const { createOpenAI } = await import('@ai-sdk/openai')
    return createOpenAI({ apiKey, baseURL: provider.api ?? undefined })(modelId)
  }
  if (provider.id === 'openrouter' || provider.npm === '@openrouter/ai-sdk-provider') {
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider')
    return createOpenRouter({ apiKey, baseURL: provider.api ?? undefined }).chat(modelId)
  }
  const baseURL = providerBaseUrl(provider)
  if (!baseURL) throw new AiConfigError(`no base URL known for ${provider.id}`)
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
  return createOpenAICompatible({ name: provider.id, apiKey, baseURL }).chatModel(modelId)
}

/** Everything a feature needs to call a model. */
export interface FeatureCtx {
  model: LanguageModel
  info: CatalogModel
  /** Output language name, see `outputLanguage`. */
  language: string
  signal?: AbortSignal
  onUsage?: UsageSink
  now?: () => number
}

export interface StructuredRequest<T> {
  feature: AiFeature
  system: string
  prompt: string
  schema: z.ZodType<T>
}

function tokens(u: { inputTokens: number | undefined; outputTokens: number | undefined }): TokenUsage {
  return { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 }
}

function record(ctx: FeatureCtx, feature: AiFeature, usage: TokenUsage): void {
  ctx.onUsage?.(usageEvent(feature, ctx.info, usage, (ctx.now ?? Date.now)()))
}

export async function generateStructured<T>(ctx: FeatureCtx, req: StructuredRequest<T>): Promise<T> {
  const res = await generateText({
    model: ctx.model,
    system: req.system,
    prompt: req.prompt,
    output: Output.object({ schema: req.schema }),
    abortSignal: ctx.signal,
  })
  record(ctx, req.feature, tokens(res.totalUsage))
  return res.output
}

export interface StructuredStream<T> {
  partial: AsyncIterable<DeepPartial<T>>
  output: Promise<T>
}

export function streamStructured<T>(ctx: FeatureCtx, req: StructuredRequest<T>): StructuredStream<T> {
  const res = streamText({
    model: ctx.model,
    system: req.system,
    prompt: req.prompt,
    output: Output.object({ schema: req.schema }),
    abortSignal: ctx.signal,
  })
  const output = (async () => {
    const value = await res.output
    record(ctx, req.feature, tokens(await res.totalUsage))
    return value
  })()
  return { partial: res.partialOutputStream, output }
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = { en: 'English', de: 'German', fr: 'French' }

/** The course's language when set, otherwise the UI's. */
export function outputLanguage(courseLanguage: string | undefined, uiLocale: string): string {
  const code = courseLanguage?.trim() || uiLocale
  return LANGUAGE_NAMES[code] ?? code
}
