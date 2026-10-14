import { z } from 'zod'

export const sourceRefSchema = z.object({
  sourceId: z.string().describe('id attribute of the cited <<<SOURCE>>> block'),
  page: z.number().int().positive().optional().describe('page attribute of the cited block, if any'),
})
export type SourceRef = z.infer<typeof sourceRefSchema>

export const understandSchema = z.object({
  title: z.string(),
  summary: z.string(),
  points: z.array(
    z.object({
      heading: z.string(),
      explanation: z.string(),
      sourceRef: sourceRefSchema.optional(),
    }),
  ),
})
export type Understanding = z.infer<typeof understandSchema>

export const cardDraftSchema = z.object({
  kind: z.enum(['basic', 'cloze']),
  front: z.string().describe('question, or for cloze the full text with {{c1::hidden}} deletions'),
  back: z.string().describe('answer; may be empty for cloze'),
  sourceRef: sourceRefSchema.optional(),
})
export type CardDraft = z.infer<typeof cardDraftSchema>
export const generateCardsSchema = z.object({ cards: z.array(cardDraftSchema) })

export const explainCardSchema = z.object({
  explanation: z.string(),
  example: z.string().optional(),
  mnemonic: z.string().optional(),
  sourceRef: sourceRefSchema.optional(),
})
export type CardExplanation = z.infer<typeof explainCardSchema>

export const gradeAnswerSchema = z.object({
  suggestedRating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  correct: z.boolean(),
  feedback: z.string(),
})
export type AnswerGrade = z.infer<typeof gradeAnswerSchema>

export const quizQuestionSchema = z.object({
  question: z.string(),
  choices: z.array(z.string()).min(2),
  answerIndex: z.number().int().nonnegative(),
  explanation: z.string(),
  sourceRef: sourceRefSchema.optional(),
})
export type QuizQuestion = z.infer<typeof quizQuestionSchema>
export const quizSchema = z.object({ questions: z.array(quizQuestionSchema) })

export const improveCardSchema = z.object({
  front: z.string(),
  back: z.string(),
  rationale: z.string(),
})
export type CardImprovement = z.infer<typeof improveCardSchema>

export const explainBackSchema = z.object({
  score: z.number().min(0).max(100),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
  misconceptions: z.array(z.string()),
  feedback: z.string(),
})
export type ExplainBackReview = z.infer<typeof explainBackSchema>
