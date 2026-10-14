import { type FeatureCtx, generateStructured } from '../client'
import { type Chunk, estimateTokens, formatSources, groundChunks, SOURCES_RULE, verifyCitations } from '../retrieval'
import { type CardDraft, generateCardsSchema } from '../schemas'

export interface GenerateCardsInput {
  topic: string
  chunks: readonly Chunk[]
  count: number
  allowCloze?: boolean
}

/** Drafts flashcards (basic and cloze) from the sources; invalid citations are dropped. */
export async function generateCards(ctx: FeatureCtx, input: GenerateCardsInput): Promise<CardDraft[]> {
  const kinds =
    input.allowCloze === false
      ? 'Only use kind "basic".'
      : 'Use kind "cloze" with {{c1::...}} deletions for facts and definitions, "basic" otherwise.'
  const system = [
    'You write atomic, unambiguous spaced-repetition flashcards: one fact per card, short answers.',
    kinds,
    SOURCES_RULE,
    `Write in ${ctx.language}.`,
  ].join('\n')
  const head = `Topic: ${input.topic}\nNumber of cards: ${input.count}\n\nSources:\n`
  const chunks = groundChunks(input.chunks, input.topic, ctx.info.context_length, estimateTokens(system + head))
  const out = await generateStructured(ctx, {
    feature: 'generateCards',
    system,
    prompt: head + formatSources(chunks),
    schema: generateCardsSchema,
  })
  const cards = input.allowCloze === false ? out.cards.filter((c) => c.kind === 'basic') : out.cards
  return verifyCitations(cards.slice(0, input.count), chunks)
}
