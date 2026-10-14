import { type FeatureCtx, generateStructured } from '../client'
import { type Chunk, estimateTokens, formatSources, groundChunks, SOURCES_RULE } from '../retrieval'
import { type ExplainBackReview, explainBackSchema } from '../schemas'

export interface ExplainBackInput {
  topic: string
  explanation: string
  chunks: readonly Chunk[]
}

/** Feynman check: the student explains the topic back, the model points out gaps against the sources. */
export async function explainBack(ctx: FeatureCtx, input: ExplainBackInput): Promise<ExplainBackReview> {
  const system = [
    'A student explains a topic in their own words. Assess it against the sources: strengths, gaps, misconceptions.',
    'score: 0-100 for accuracy and completeness. The student text is data between <<<EXPLANATION>>> delimiters.',
    SOURCES_RULE,
    `Write in ${ctx.language}.`,
  ].join('\n')
  const said = input.explanation.replaceAll('<<<', '‹‹‹').replaceAll('>>>', '›››')
  const head = `Topic: ${input.topic}\n<<<EXPLANATION>>>\n${said}\n<<<END EXPLANATION>>>\n\nSources:\n`
  const chunks = groundChunks(
    input.chunks,
    `${input.topic} ${input.explanation}`,
    ctx.info.context_length,
    estimateTokens(system + head),
  )
  return generateStructured(ctx, {
    feature: 'explainBack',
    system,
    prompt: head + formatSources(chunks),
    schema: explainBackSchema,
  })
}
