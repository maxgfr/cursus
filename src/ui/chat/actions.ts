import { paths, withScope } from '../../app/routes.ts'
import type { ChatIntent } from '../../core/ai/features/tutorChat'
import type { useT } from '../../i18n/react.tsx'
import type { ScreenContext } from './context.tsx'

export type ChatActionId =
  | 'explainQuestion'
  | 'why'
  | 'hint'
  | 'mnemonic'
  | 'summarise'
  | 'approach'
  | 'generate'
  | 'understand'
  | 'quiz'

/**
 * What the panel offers for the screen: a structured answer in the thread (`rich`), a chat turn guided by an
 * instruction (`guided`), or a screen of its own, opened on the course or section (`link`).
 */
export type ChatAction =
  | { id: 'explainQuestion' | 'why'; kind: 'rich'; label: string }
  | { id: ChatActionId; kind: 'guided'; label: string; intent: ChatIntent }
  | { id: ChatActionId; kind: 'link'; label: string; href: string }

type T = ReturnType<typeof useT>

/** The actions for what is on screen, most specific first: a card, a quiz question, a source, a course. */
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
  if (!c.courseId) return []
  const scope = { courseId: c.courseId, ...(c.sectionId ? { sectionId: c.sectionId } : {}) }
  const generate: ChatAction = {
    id: 'generate',
    kind: 'link',
    label: t('chat.actionGenerate'),
    href: withScope(paths.generate, scope),
  }
  const quiz: ChatAction = { id: 'quiz', kind: 'link', label: t('chat.actionQuiz'), href: withScope(paths.quiz, scope) }
  if (c.sourceId) {
    return [{ id: 'summarise', kind: 'guided', label: t('chat.actionSummarise'), intent: 'summarise' }, generate, quiz]
  }
  return [
    generate,
    { id: 'understand', kind: 'link', label: t('chat.actionUnderstand'), href: withScope(paths.understand, scope) },
    quiz,
  ]
}

/**
 * The action run from the screen by its id. A card's actions are found whatever its state, so « Explain the
 * question » run after the reveal still runs, though the chips for a revealed card don't list it.
 */
export function actionById(t: T, c: ScreenContext, id: ChatActionId): ChatAction | undefined {
  const contexts = c.card ? [c, { ...c, card: { ...c.card, revealed: !c.card.revealed } }] : [c]
  for (const context of contexts) {
    const action = actionsFor(t, context).find((a) => a.id === id)
    if (action) return action
  }
  return undefined
}
