import {
  type DeepPartial,
  generateText,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  NoObjectGeneratedError,
  Output,
  streamText,
} from 'ai'
import type { z } from 'zod'
import type { CatalogModel, CatalogProvider } from './catalogTrim'
import type { TokenUsage } from './cost'
import { LOCAL_PROVIDER } from './local'
import { type AiFeature, type UsageSink, usageEvent } from './usage'

export class AiConfigError extends Error {}

const ANTHROPIC_API = 'https://api.anthropic.com/v1'
const ANTHROPIC_BROWSER_HEADER = 'anthropic-dangerous-direct-browser-access'

export interface ModelRef {
  provider: CatalogProvider
  modelId: string
  apiKey: string
}

/** Builds a language model; provider packages are loaded only when first needed. */
export async function createModel(ref: ModelRef): Promise<LanguageModel> {
  const { provider, modelId, apiKey } = ref
  if (provider.id === LOCAL_PROVIDER) {
    // Keyless and offline: the model runs in this browser, the engine in a worker loaded on first use.
    const { localModels } = await import('./localModels')
    return localModels().languageModel(modelId)
  }
  if (provider.browser.verdict === 'blocked') {
    throw new AiConfigError(`${provider.id} cannot be called from a browser`)
  }
  // Headers the provider asked for when it was checked (Anthropic's direct-browser header).
  const headers = provider.browser.headers
  if (provider.id === 'anthropic' || provider.npm === '@ai-sdk/anthropic') {
    const { createAnthropic } = await import('@ai-sdk/anthropic')
    const baseURL = provider.api ?? undefined
    // The header is Anthropic's own opt-in: it goes to Anthropic's host, never to another server
    // that merely speaks the same protocol (MiniMax, a proxy).
    const own = new URL(baseURL ?? ANTHROPIC_API).host === new URL(ANTHROPIC_API).host
    return createAnthropic({
      apiKey,
      baseURL,
      headers: own ? { [ANTHROPIC_BROWSER_HEADER]: 'true', ...headers } : headers,
    })(modelId)
  }
  if (provider.id === 'google' || provider.npm === '@ai-sdk/google') {
    const { createGoogle } = await import('@ai-sdk/google')
    return createGoogle({ apiKey, baseURL: provider.api ?? undefined, headers })(modelId)
  }
  if (provider.id === 'openai' || provider.npm === '@ai-sdk/openai') {
    const { createOpenAI } = await import('@ai-sdk/openai')
    return createOpenAI({ apiKey, baseURL: provider.api ?? undefined, headers })(modelId)
  }
  if (provider.id === 'openrouter' || provider.npm === '@openrouter/ai-sdk-provider') {
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider')
    return createOpenRouter({ apiKey, baseURL: provider.api ?? undefined, headers }).chat(modelId)
  }
  const baseURL = provider.api
  if (!baseURL) throw new AiConfigError(`no base URL known for ${provider.id}`)
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
  return createOpenAICompatible({ name: provider.id, apiKey, baseURL, headers }).chatModel(modelId)
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

/**
 * Records what a failed call was still billed for, then rethrows: an answer that came back but did not parse or
 * match the schema (`NoObjectGeneratedError`, truncated or invalid JSON) cost its tokens all the same, and a
 * retry pays again. Unreported, the spending, the synced usage and the caps would all under-count.
 */
function recordFailure(ctx: FeatureCtx, feature: AiFeature, e: unknown): never {
  if (NoObjectGeneratedError.isInstance(e) && e.usage) record(ctx, feature, tokens(e.usage))
  throw e
}

/**
 * Runs one structured call and reports its usage, whether its answer is used or refused (see `recordFailure`).
 * Every feature calling `generateText` directly goes through here.
 */
export async function billed<T>(
  ctx: FeatureCtx,
  feature: AiFeature,
  call: () => PromiseLike<{ output: T; totalUsage: LanguageModelUsage }>,
): Promise<T> {
  let res: { output: T; totalUsage: LanguageModelUsage }
  try {
    res = await call()
  } catch (e) {
    recordFailure(ctx, feature, e)
  }
  record(ctx, feature, tokens(res.totalUsage))
  return res.output
}

export function generateStructured<T>(ctx: FeatureCtx, req: StructuredRequest<T>): Promise<T> {
  return billed(ctx, req.feature, () =>
    generateText({
      model: ctx.model,
      system: req.system,
      prompt: req.prompt,
      output: Output.object({ schema: req.schema }),
      abortSignal: ctx.signal,
    }),
  )
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
    let value: T
    try {
      value = await res.output
    } catch (e) {
      recordFailure(ctx, req.feature, e)
    }
    record(ctx, req.feature, tokens(await res.totalUsage))
    return value
  })()
  return { partial: res.partialOutputStream, output }
}

export interface ChatRequest {
  feature: AiFeature
  system: string
  messages: ModelMessage[]
}

/**
 * One free-text conversational turn, streamed: yields the answer's text as it arrives. Usage is reported once
 * the model finishes; a provider error is thrown from the iteration. Stopped through `ctx.signal`, the stream
 * just ends.
 */
export async function* streamChat(ctx: FeatureCtx, req: ChatRequest): AsyncGenerator<string, void> {
  const res = streamText({
    model: ctx.model,
    system: req.system,
    messages: req.messages,
    abortSignal: ctx.signal,
    // Thrown from the iteration below instead of logged.
    onError: () => {},
  })
  for await (const part of res.fullStream) {
    if (part.type === 'text-delta') yield part.text
    else if (part.type === 'error') throw part.error
    else if (part.type === 'finish') record(ctx, req.feature, tokens(part.totalUsage))
  }
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = { en: 'English', de: 'German', fr: 'French' }

/** The course's language when set, otherwise the UI's. */
export function outputLanguage(courseLanguage: string | undefined, uiLocale: string): string {
  const code = courseLanguage?.trim() || uiLocale
  return LANGUAGE_NAMES[code] ?? code
}
