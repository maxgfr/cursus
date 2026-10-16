import type { ChatIntent } from '../../core/ai/features/tutorChat'
import type { useT } from '../../i18n/react.tsx'
import type { ScreenContext } from './context.tsx'

/** A chat turn guided by an instruction, asked from the panel. */
export interface ChatAction {
  id: 'approach'
  kind: 'guided'
  label: string
  intent: ChatIntent
}

type T = ReturnType<typeof useT>

/**
 * The turns offered at the top of the panel for what is on screen. The chat converses: each AI feature has its own
 * place on its screen; only a quiz question gets « Help me approach this question » (never its answer).
 */
export function actionsFor(t: T, c: ScreenContext): ChatAction[] {
  if (c.question && !c.card) {
    return [{ id: 'approach', kind: 'guided', label: t('chat.actionApproach'), intent: 'approach' }]
  }
  return []
}
