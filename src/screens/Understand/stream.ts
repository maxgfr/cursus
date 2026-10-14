import type { DeepPartial } from 'ai'
import { type FeatureCtx, streamStructured } from '../../core/ai/client'
import {
  type Chunk,
  estimateTokens,
  formatSources,
  groundChunks,
  SOURCES_RULE,
  verifyCitations,
} from '../../core/ai/retrieval'
import { type Understanding, understandSchema } from '../../core/ai/schemas'

export type Level = 'basics' | 'standard' | 'deep'

const LEVELS: Record<Level, string> = {
  basics: 'The student is new to the subject: use plain words, define every term, prefer concrete examples.',
  standard: 'The student knows the basics: be precise and connect ideas.',
  deep: 'The student wants depth: cover edge cases, formal definitions and common misconceptions.',
}

export interface UnderstandingStream {
  partial: AsyncIterable<DeepPartial<Understanding>>
  output: Promise<Understanding>
  /** The passages actually sent; streamed citations are shown only when they point at one. */
  grounded: Chunk[]
}

/** Streaming twin of core `understand`: same prompt and citation check, plus the chosen level. */
export function streamUnderstanding(
  ctx: FeatureCtx,
  input: { topic: string; level: Level; chunks: readonly Chunk[] },
): UnderstandingStream {
  const system = [
    'You are a patient tutor helping a student understand a topic from their own course material.',
    'Break the topic into clear points, from fundamentals to subtleties. Attach a sourceRef to each point grounded in a source.',
    LEVELS[input.level],
    SOURCES_RULE,
    `Write in ${ctx.language}.`,
  ].join('\n')
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
