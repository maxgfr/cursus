import type { DeepPartial } from 'ai'
import { type FeatureCtx, generateStructured, streamStructured } from '../client'
import { type Chunk, estimateTokens, formatSources, groundChunks, SOURCES_RULE, verifyCitations } from '../retrieval'
import { type Understanding, understandSchema } from '../schemas'

export interface UnderstandInput {
  topic: string
  chunks: readonly Chunk[]
}

const TUTOR = [
  'You are a patient tutor helping a student understand a topic from their own course material.',
  'Break the topic into clear points, from fundamentals to subtleties. Attach a sourceRef to each point grounded in a source.',
]

/** Explains a topic from the student's sources; every point cites a provided source or none. */
export async function understand(ctx: FeatureCtx, input: UnderstandInput): Promise<Understanding> {
  const system = [...TUTOR, SOURCES_RULE, `Write in ${ctx.language}.`].join('\n')
  const head = `Topic: ${input.topic}\n\nSources:\n`
  const chunks = groundChunks(input.chunks, input.topic, ctx.info.context_length, estimateTokens(system + head))
  const out = await generateStructured(ctx, {
    feature: 'understand',
    system,
    prompt: head + formatSources(chunks),
    schema: understandSchema,
  })
  return { ...out, points: verifyCitations(out.points, chunks) }
}

/** How much the study sheet goes into: a short one keeps to the essentials. */
export type Detail = 'short' | 'standard' | 'deep'

const DETAILS: Record<Detail, string> = {
  short: 'Keep it short: only the essential points, in plain words, every term defined.',
  standard: 'The student knows the basics: be precise and connect ideas.',
  deep: 'The student wants depth: cover edge cases, formal definitions and common misconceptions.',
}

export interface UnderstandingStream {
  partial: AsyncIterable<DeepPartial<Understanding>>
  output: Promise<Understanding>
  /** The passages actually sent; streamed citations are shown only when they point at one. */
  grounded: Chunk[]
}

/** Streaming twin of `understand`: same prompt and citation check, plus the chosen detail. */
export function streamUnderstanding(ctx: FeatureCtx, input: UnderstandInput & { detail: Detail }): UnderstandingStream {
  const system = [...TUTOR, DETAILS[input.detail], SOURCES_RULE, `Write in ${ctx.language}.`].join('\n')
  const head = `Topic: ${input.topic}\n\nSources:\n`
  const grounded = groundChunks(input.chunks, input.topic, ctx.info.context_length, estimateTokens(system + head))
  const s = streamStructured(ctx, {
    feature: 'understand',
    system,
    prompt: head + formatSources(grounded),
    schema: understandSchema,
  })
  const output = s.output.then((o) => ({ ...o, points: verifyCitations(o.points, grounded) }))
  return { partial: s.partial, output, grounded }
}
