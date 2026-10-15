import type { ChatIntent } from '../../core/ai/features/tutorChat'
import type { useT } from '../../i18n/react.tsx'
import type { ScreenContext } from './context.tsx'

/** A study action: written in the thread from the course's sources, with its options to change and run again. */
export type StudyKind = 'generate' | 'quiz' | 'understand'

export type ChatActionId =
  | 'explainQuestion'
  | 'why'
  | 'hint'
  | 'mnemonic'
  | 'summarise'
  | 'approach'
  | StudyKind
  | 'ownWords'
  | 'improve'
  | 'explainPhoto'
  | 'suggestCards'

/**
 * What the panel does for the screen, always in its thread: a structured answer about the card (`rich`), a chat
 * turn guided by an instruction (`guided`), a study action written from the sources (`study`), an answer typed in
 * the student's own words then graded (`answer`), a rewrite of the card (`improve`), a photo read (`photo`), or
 * cards proposed on a source by the background queue (`job`).
 */
export type ChatAction =
  | { id: 'explainQuestion' | 'why'; kind: 'rich'; label: string }
  | { id: ChatActionId; kind: 'guided'; label: string; intent: ChatIntent }
  | { id: StudyKind; kind: 'study'; label: string }
  | { id: 'ownWords'; kind: 'answer'; label: string }
  | { id: 'improve'; kind: 'improve'; label: string }
  | { id: 'explainPhoto'; kind: 'photo'; label: string }
  | { id: 'suggestCards'; kind: 'job'; label: string }

type T = ReturnType<typeof useT>

const study = (t: T, id: StudyKind): ChatAction => ({
  id,
  kind: 'study',
  label:
    id === 'generate' ? t('chat.actionGenerate') : id === 'quiz' ? t('chat.actionQuiz') : t('chat.actionWriteSheet'),
})

/** The actions offered at the top of the panel for what is on screen, most specific first. */
export function actionsFor(t: T, c: ScreenContext): ChatAction[] {
  if (c.card) {
    return c.card.revealed
      ? [
          { id: 'why', kind: 'rich', label: t('chat.actionWhy') },
          { id: 'mnemonic', kind: 'guided', label: t('chat.actionMnemonic'), intent: 'mnemonic' },
        ]
      : [
          { id: 'explainQuestion', kind: 'rich', label: t('chat.actionExplainQuestion') },
          { id: 'hint', kind: 'guided', label: t('chat.actionHint'), intent: 'hint' },
        ]
  }
  if (c.question) return [{ id: 'approach', kind: 'guided', label: t('chat.actionApproach'), intent: 'approach' }]
  if (c.photoId) return [{ id: 'explainPhoto', kind: 'photo', label: t('chat.actionExplainPhoto') }]
  if (!c.courseId) return []
  if (c.sourceId) {
    return [
      { id: 'summarise', kind: 'guided', label: t('chat.actionSummarise'), intent: 'summarise' },
      study(t, 'generate'),
      study(t, 'quiz'),
    ]
  }
  // A study sheet on a topic, written from the sources: generic questions stay in this chat.
  return [study(t, 'generate'), study(t, 'understand'), study(t, 'quiz')]
}

/**
 * The action run from the screen by its id. A card's actions are found whatever its state, so « Explain the
 * question » run after the reveal still runs, though the chips for a revealed card don't list it. Some actions are
 * only run from the screen, never offered as chips: answering in one's own words and improving a card (in review),
 * cards proposed on a source; a study action runs wherever it is asked, from the first course when the screen
 * shows none.
 */
export function actionById(t: T, c: ScreenContext, id: ChatActionId): ChatAction | undefined {
  if (id === 'ownWords')
    return c.card && !c.card.revealed ? { id, kind: 'answer', label: t('chat.actionOwnWords') } : undefined
  if (id === 'improve') return c.card?.id ? { id, kind: 'improve', label: t('chat.actionImprove') } : undefined
  if (id === 'suggestCards') return c.sourceId ? { id, kind: 'job', label: t('chat.actionSuggestCards') } : undefined
  if (id === 'explainPhoto') {
    return c.photoId ? { id, kind: 'photo', label: t('chat.actionExplainPhoto') } : undefined
  }
  if (id === 'generate' || id === 'quiz' || id === 'understand') return study(t, id)
  const contexts = c.card ? [c, { ...c, card: { ...c.card, revealed: !c.card.revealed } }] : [c]
  for (const context of contexts) {
    const action = actionsFor(t, context).find((a) => a.id === id)
    if (action) return action
  }
  return undefined
}
