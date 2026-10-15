import { BrainCircuit, CircleHelp, KeyRound, Lightbulb, type LucideIcon, MessageCircle } from 'lucide-react'
import { useCallback, useId } from 'react'
import { useT } from '../../i18n/react.tsx'
import { actionsFor, type ChatActionId } from '../../ui/chat/actions.ts'
import { useChat } from '../../ui/chat/context.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { askAbout, keepSelection, useCanCallAi, useSelectedTerm } from '../../ui/ExplainLauncher.tsx'
import type { AiModelState } from '../Understand/shared/aiConfig.ts'
import styles from './ExplainActions.module.css'
import type { CardView } from './session.ts'

const ICONS: Partial<Record<ChatActionId, LucideIcon>> = {
  explainQuestion: CircleHelp,
  hint: KeyRound,
  why: Lightbulb,
  mnemonic: BrainCircuit,
}

/**
 * The card's options below it: « Explain the question » in both states (short labels, as on the card), then the
 * chat's own card actions for the state (a hint before the reveal; why and a mnemonic after it).
 */
function cardActions(t: ReturnType<typeof useT>, revealed: boolean): { id: ChatActionId; label: string }[] {
  const chat = actionsFor(t, { card: { front: '', back: '', revealed } }).filter((a) => a.id !== 'explainQuestion')
  return [
    { id: 'explainQuestion', label: t('ai.explainQuestion') },
    ...chat.map((a) => ({ id: a.id, label: a.id === 'why' ? t('review.why') : a.label })),
  ]
}

/** The faces of the card on screen: a term selected there can be asked about. */
const FACES = '[data-testid="question"], [data-testid="answer"]'

/**
 * « Explain the question », before and after the reveal (before it, the answer never shows), « Why? » once the
 * answer shows, and, while a term of the card is selected, « Ask about “term” »: each opens the chat beside the
 * card and answers there, in its thread, knowing the card and keeping its answer hidden as long as the card does. Only offered once a model is set up: the focus view carries no setup
 * path. Offline, both are disabled, saying why, unless the model runs on this device.
 */
export function ExplainActions({ card, revealed, ai }: { card: CardView; revealed: boolean; ai: AiModelState }) {
  const t = useT()
  const chat = useChat()
  const online = useCanCallAi(ai)
  const offlineId = useId()
  const scopeOf = useCallback((el: Element) => el.closest(FACES), [])
  const { selected, launcher, clear } = useSelectedTerm(scopeOf)

  // Shown by the card once the app's readiness says a model is ready; `ai` only says whether it runs offline.
  if (!chat) return null

  const askTerm = () => {
    if (!selected) return
    // A term is read in the question alone until the answer shows; a passage is sent as it is.
    const { question, excerpt } = askAbout(t, selected)
    chat.ask(question, selected.passage ? excerpt : revealed ? `${card.front}\n\n${card.back}` : card.front)
    clear()
  }

  return (
    <div className={styles.explain}>
      <div ref={launcher} className={styles.actions}>
        {/* The card's actions, the same as at the top of the chat: each one opens the chat on it. */}
        {cardActions(t, revealed).map((a) => {
          const Icon = ICONS[a.id] ?? MessageCircle
          return (
            <Button
              key={a.id}
              variant="plain"
              icon={<Icon size={18} strokeWidth={1.75} aria-hidden />}
              disabled={!online}
              aria-describedby={online ? undefined : offlineId}
              onClick={() => chat.run(a.id)}
            >
              {a.label}
            </Button>
          )
        })}
        {selected && (
          <Button
            variant="plain"
            icon={<MessageCircle size={18} strokeWidth={1.75} aria-hidden />}
            disabled={!online}
            aria-describedby={online ? undefined : offlineId}
            onMouseDown={keepSelection}
            onClick={askTerm}
          >
            {askAbout(t, selected).label}
          </Button>
        )}
      </div>
      {!online && (
        <p id={offlineId} className={styles.note}>
          {t('ai.explainOffline')}
        </p>
      )}
    </div>
  )
}
