import { type FeatureCtx, generateStructured } from '../client'
import { type Chunk, estimateTokens, formatSources, groundChunks, SOURCES_RULE, verifyCitations } from '../retrieval'
import { type CardExplanation, explainCardSchema } from '../schemas'

export interface ExplainCardInput {
  front: string
  back: string
  chunks?: readonly Chunk[]
}

/** Explains why a card's answer is what it is, optionally grounded in sources. */
export async function explainCard(ctx: FeatureCtx, input: ExplainCardInput): Promise<CardExplanation> {
  const system = [
    'A student just reviewed this flashcard and wants to understand the answer, not just memorize it.',
    'Explain briefly; add an example or a mnemonic when helpful.',
    SOURCES_RULE,
    `Write in ${ctx.language}.`,
  ].join('\n')
  const head = `Front: ${input.front}\nBack: ${input.back}\n\nSources:\n`
  const chunks = groundChunks(input.chunks ?? [], input.front, ctx.info.context_length, estimateTokens(system + head))
  const out = await generateStructured(ctx, {
    feature: 'explainCard',
    system,
    prompt: head + formatSources(chunks),
    schema: explainCardSchema,
  })
  const [checked] = verifyCitations([out], chunks)
  return checked ?? out
}
