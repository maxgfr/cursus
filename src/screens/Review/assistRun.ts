import { explainCard } from '../../core/ai/features/explainCard'
import { EXPLAIN_OUTPUT_TOKENS, explainQuestion } from '../../core/ai/features/explainQuestion'
import { gradeAnswer } from '../../core/ai/features/gradeAnswer'
import { improveCard } from '../../core/ai/features/improveCard'
import {
  buildTutorTurn,
  type CardRich,
  type ChatIntent,
  keepValidCitations,
  type StudyOptions,
  tutorChat,
} from '../../core/ai/features/tutorChat'
import type { Chunk } from '../../core/ai/retrieval'
import type { CardImprovement } from '../../core/ai/schemas'
import type { Id } from '../../core/contracts/workspace'
import type { ModelWorkspace } from '../../core/model/workspace'
import type { ReadyModel } from '../../ui/chat/studyRun.ts'
import { cardText, passagesText } from '../Understand/shared/aiConfig.ts'
import { estimateCost } from '../Understand/shared/sources.ts'

/** What a card's help runs on: the workspace, the model ready, and the course's passages. */
export interface AssistDeps {
  ws: ModelWorkspace
  ai: ReadyModel
  load: (o: Pick<StudyOptions, 'sourceIds' | 'pasted'>) => Promise<Chunk[]>
}

type Card = { front: string; back: string; revealed: boolean }

function courseOf(d: AssistDeps, courseId: Id) {
  const course = d.ws.courses.get(courseId)
  return { course, ids: d.ws.sources.list({ courseId }).map((s) => s.id) }
}

/** « Explain the question » or « Why? »: a structured answer grounded in the course, streamed through `onPartial`. */
export async function explainRun(
  d: AssistDeps,
  kind: CardRich['kind'],
  card: Card,
  courseId: Id,
  signal: AbortSignal,
  onPartial: (p: unknown) => void,
): Promise<{ rich: CardRich; chunks: Chunk[] }> {
  const { course, ids } = courseOf(d, courseId)
  const chunks = await d.load({ sourceIds: ids, pasted: '' })
  const ctx = {
    ...(await d.ai.context(signal, course?.language, [cardText(card), passagesText(chunks)])),
    onPartial,
  }
  const faces = { front: card.front, back: card.back }
  const input = { chunks, courseTitle: course?.title }
  const cost = estimateCost(d.ai.info, chunks, EXPLAIN_OUTPUT_TOKENS)
  const rich: CardRich =
    kind === 'explainQuestion'
      ? {
          kind,
          card: faces,
          cost,
          value: await explainQuestion(ctx, { card: faces, revealed: card.revealed, ...input }),
        }
      : { kind, card: faces, cost, value: await explainCard(ctx, { ...faces, ...input }) }
  return { rich, chunks }
}

/** « A hint » or « A mnemonic »: the tutor's answer, told the card (its answer kept hidden until the reveal). */
export async function guidedRun(
  d: AssistDeps,
  intent: ChatIntent,
  label: string,
  card: Card,
  courseId: Id,
  signal: AbortSignal,
  onText: (text: string, chunks: Chunk[]) => void,
): Promise<{ text: string; chunks: Chunk[] }> {
  const { course, ids } = courseOf(d, courseId)
  const loaded = await d.load({ sourceIds: ids, pasted: '' })
  const ctx = await d.ai.context(signal, course?.language, [cardText(card), passagesText(loaded)])
  const about = { ...(course ? { courseTitle: course.title } : {}), card, intent }
  const turn = buildTutorTurn(about, [{ role: 'user', text: label }], loaded, ctx.info, ctx.language)
  let text = ''
  for await (const delta of tutorChat(ctx, turn)) {
    text += delta
    onText(text, turn.chunks)
  }
  return { text: keepValidCitations(text, turn.chunks).trim(), chunks: turn.chunks }
}

/** An answer typed in one's own words, graded against the card (the student keeps the final say). */
export async function gradeRun(
  d: AssistDeps,
  card: { front: string; back: string },
  answer: string,
  courseId: Id,
  signal: AbortSignal,
): Promise<{ rating: 1 | 2 | 3 | 4; feedback: string }> {
  const ctx = await d.ai.context(signal, d.ws.courses.get(courseId)?.language, cardText(card))
  const g = await gradeAnswer(ctx, { ...card, answer })
  return { rating: g.suggestedRating, feedback: g.feedback }
}

/** A rewrite of a hard card, streamed through `onPartial`. */
export async function improveRun(
  d: AssistDeps,
  card: { front: string; back: string; kind: 'basic' | 'cloze' },
  courseId: Id,
  signal: AbortSignal,
  onPartial: (p: unknown) => void,
): Promise<CardImprovement> {
  const ctx = await d.ai.context(signal, d.ws.courses.get(courseId)?.language, cardText(card))
  return improveCard({ ...ctx, onPartial }, card)
}
