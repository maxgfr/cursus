import { type FeatureCtx, generateStructured } from '../client'
import { type Chunk, estimateTokens, formatSources, groundChunks, SOURCES_RULE, verifyCitations } from '../retrieval'
import { type QuizQuestion, quizSchema } from '../schemas'

export interface QuizInput {
  topic: string
  chunks: readonly Chunk[]
  /** How many questions, or `'all'`: as many as it takes to cover the sources, up to `QUIZ_ALL_MAX`. */
  count: number | 'all'
}

/** The most questions a quiz covering everything asks: past it, a quiz is better split by topic or section. */
export const QUIZ_ALL_MAX = 20

/** Multiple-choice self-test. Results are informational only: a quiz never feeds FSRS. */
export async function quiz(ctx: FeatureCtx, input: QuizInput): Promise<QuizQuestion[]> {
  const system = [
    'Write multiple-choice questions testing understanding, with plausible distractors and one correct choice.',
    SOURCES_RULE,
    `Write in ${ctx.language}.`,
  ].join('\n')
  const count =
    input.count === 'all'
      ? `as many as it takes to cover every key point of the sources, at most ${QUIZ_ALL_MAX}`
      : String(input.count)
  const head = `Topic: ${input.topic}\nNumber of questions: ${count}\n\nSources:\n`
  const chunks = groundChunks(input.chunks, input.topic, ctx.info.context_length, estimateTokens(system + head))
  const out = await generateStructured(ctx, {
    feature: 'quiz',
    system,
    prompt: head + formatSources(chunks),
    schema: quizSchema,
  })
  const wellFormed = out.questions.filter((q) => q.answerIndex < q.choices.length)
  return verifyCitations(wellFormed.slice(0, input.count === 'all' ? QUIZ_ALL_MAX : input.count), chunks)
}
