import type { ChatIntent } from '../../core/ai/features/tutorChat'
import type { useT } from '../../i18n/react.tsx'
import type { ScreenContext } from './context.tsx'

/** A chat turn guided by an instruction, asked from the panel. */
export interface ChatAction {
  id: ChatIntent
  kind: 'guided'
  label: string
  intent: ChatIntent
}

type T = ReturnType<typeof useT>

const LABELS = {
  approach: 'chat.actionApproach',
  explainCard: 'chat.suggestExplainCard',
  example: 'chat.suggestExample',
  explainSection: 'chat.suggestExplainSection',
  summariseWritten: 'chat.suggestSummariseWritten',
  askMe: 'chat.suggestAskMe',
  summariseCourse: 'chat.suggestSummariseCourse',
  whatToReview: 'chat.suggestWhatToReview',
  explainSource: 'chat.suggestExplainSource',
} as const

/**
 * The turns offered above the composer for what is on screen. A quiz question always gets « Help me approach this
 * question » (never its answer). Within a course, a new thread starts from a suggestion about the card, source,
 * section or course on screen; in review the card's own help sits below it, so nothing is suggested there.
 */
export function actionsFor(t: T, c: ScreenContext, { empty }: { empty: boolean }): ChatAction[] {
  const make = (...ids: (keyof typeof LABELS)[]): ChatAction[] =>
    ids.map((id) => ({ id, kind: 'guided', label: t(LABELS[id]), intent: id }))
  if (c.question && !c.card) return make('approach')
  if (!empty || !c.courseId) return []
  if (c.card) return c.card.revealed && !c.review ? make('explainCard', 'example') : []
  if (c.sourceId || c.photoId) return make('explainSource')
  if (c.sectionId) return make('explainSection', 'summariseWritten', 'askMe')
  return make('summariseCourse', 'whatToReview')
}
