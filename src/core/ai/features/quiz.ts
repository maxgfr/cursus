import { type FeatureCtx, generateStructured } from '../client'
import { type Chunk, estimateTokens, formatSources, groundChunks, SOURCES_RULE, verifyCitations } from '../retrieval'
import { type QuizQuestion, quizSchema } from '../schemas'

export type QuizDifficulty = 'easy' | 'standard' | 'hard'

export interface QuizInput {
  topic: string
  chunks: readonly Chunk[]
  /** How many questions, or `'all'`: as many as it takes to cover the sources, up to `QUIZ_ALL_MAX`. */
  count: number | 'all'
  /** How demanding the questions are; standard when absent. */
  difficulty?: QuizDifficulty
  /** Points the student keeps getting wrong (the fronts of their weakest cards): asked about first. */
  focus?: readonly string[]
}

/** The most questions a quiz covering everything asks: past it, a quiz is better split by topic or section. */
export const QUIZ_ALL_MAX = 20

const DIFFICULTY: Readonly<Record<Exclude<QuizDifficulty, 'standard'>, string>> = {
  easy: 'easy: direct recall of the key facts, with clearly distinct choices',
  hard: 'hard: application and reasoning across the sources, with close distractors',
}

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
  const lines = [`Topic: ${input.topic}`, `Number of questions: ${count}`]
  if (input.difficulty && input.difficulty !== 'standard') lines.push(`Difficulty: ${DIFFICULTY[input.difficulty]}`)
  const focus = (input.focus ?? []).map((f) => f.trim()).filter((f) => f !== '')
  if (focus.length > 0) {
    lines.push(
      `Weak points to test first (the student keeps getting these wrong; ask about what the sources say on them):\n${focus.map((f) => `- ${f}`).join('\n')}`,
    )
  }
  const head = `${lines.join('\n')}\n\nSources:\n`
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
