import { type FeatureCtx, generateStructured } from '../client'
import { type Chunk, estimateTokens, formatSources, groundChunks, SOURCES_RULE, verifyCitations } from '../retrieval'
import { type Understanding, understandSchema } from '../schemas'

export interface UnderstandInput {
  topic: string
  chunks: readonly Chunk[]
}

/** Explains a topic from the student's sources; every point cites a provided source or none. */
export async function understand(ctx: FeatureCtx, input: UnderstandInput): Promise<Understanding> {
  const system = [
    'You are a patient tutor helping a student understand a topic from their own course material.',
    'Break the topic into clear points, from fundamentals to subtleties. Attach a sourceRef to each point grounded in a source.',
    SOURCES_RULE,
    `Write in ${ctx.language}.`,
  ].join('\n')
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
