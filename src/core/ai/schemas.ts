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
  citations: z.array(sourceRefSchema).optional(),
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

export const explainQuestionSchema = z.object({
  restatement: z.string().describe('what the question asks, in plain words, without answering it'),
  terms: z.array(
    z.object({
      term: z.string().describe('a term that appears in the question'),
      definition: z.string(),
      sourceRef: sourceRefSchema.optional(),
    }),
  ),
  context: z.string().describe('where the question fits in the course and why it matters'),
  citations: z.array(sourceRefSchema).describe('blocks of the course that help understand the question'),
})
export type QuestionExplanationDraft = z.infer<typeof explainQuestionSchema>

export const explainConceptSchema = z.object({
  definition: z.string().describe('one or two sentences'),
  explanation: z.string(),
  example: z.string(),
  relatedConcepts: z.array(z.string()).describe('neighbouring concepts worth exploring next, as short terms'),
  citations: z.array(sourceRefSchema),
  suggestedCard: z.object({
    front: z.string().describe('an atomic question about the concept'),
    back: z.string().describe('its short answer'),
  }),
})
export type ConceptExplanation = z.infer<typeof explainConceptSchema>

export const photoDescriptionSchema = z.object({
  kind: z
    .enum(['table', 'slide', 'handwriting', 'diagram', 'document', 'other'])
    .describe('what the photo mainly shows'),
  title: z.string().describe('a short title for what the photo shows'),
  transcription: z
    .string()
    .describe(
      'every legible word, verbatim and in its original language, in reading order; tables as Markdown tables; empty if there is no text',
    ),
  explanation: z
    .string()
    .describe('what the content means for a student: the diagram explained, the idea of the slide'),
  keyPoints: z.array(z.string()).describe('the few facts worth remembering, as short sentences'),
})
export type PhotoDescription = z.infer<typeof photoDescriptionSchema>

const unitNumbers = z.array(z.number().int()).describe('numbers of the <<<UNIT n="...">>> blocks concerned')

/** A deck (slides, sections or pages) read unit by unit: outline, key notions, recurring ideas, summaries. */
export const deckReadingSchema = z.object({
  title: z.string().describe('what the material is about, in a few words'),
  outline: z.array(z.object({ heading: z.string(), units: unitNumbers })).describe('the plan, in order'),
  notions: z
    .array(z.object({ term: z.string(), definition: z.string().describe('one sentence'), units: unitNumbers }))
    .describe('the key notions a student must know'),
  recurring: z
    .array(z.object({ theme: z.string(), units: unitNumbers }))
    .describe('ideas that come back across several units'),
  units: z
    .array(z.object({ unit: z.number().int(), summary: z.string().describe('two sentences at most') }))
    .describe('one entry per unit read'),
})
export type DeckReadingDraft = z.infer<typeof deckReadingSchema>
export const deckSynthesisSchema = deckReadingSchema.omit({ units: true })

export const deckQuestionSchema = z.object({
  unit: z.number().int().describe('n of the <<<UNIT>>> block the question is about'),
  type: z.enum(['qa', 'cloze', 'explain']),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  front: z
    .string()
    .describe('qa: the question; cloze: the full sentence with {{c1::hidden}} deletions; explain: the prompt'),
  back: z.string().describe('qa: the short answer; cloze: empty; explain: a model answer in a few sentences'),
  quote: z.string().optional().describe('a short passage of the unit, copied verbatim, that supports the answer'),
})
export type DeckQuestionDraft = z.infer<typeof deckQuestionSchema>
export const deckQuestionsSchema = z.object({ questions: z.array(deckQuestionSchema) })
