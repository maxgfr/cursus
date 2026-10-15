import { CircleHelp, Lightbulb, MessageCircle } from 'lucide-react'
import { useCallback, useId } from 'react'
import { useT } from '../../i18n/react.tsx'
import { useChat } from '../../ui/chat/context.tsx'
import { Button } from '../../ui/components/Button.tsx'
import {
  ExplainSheetSlot,
  keepSelection,
  useCanCallAi,
  useExplainTarget,
  useSelectedTerm,
} from '../../ui/ExplainLauncher.tsx'
import type { AiModelState } from '../Understand/shared/aiConfig.ts'
import styles from './ExplainActions.module.css'
import type { CardView } from './session.ts'

/** The faces of the card on screen: a term selected there can be asked about. */
const FACES = '[data-testid="question"], [data-testid="answer"]'

/**
 * « Explain the question », before and after the reveal (before it, the sheet never shows the answer), « Why? »
 * once the answer shows (the same sheet, on why it is the answer), and,
 * while a term of the card is selected, « Ask about “term” » in the chat, which knows the card and keeps its
 * answer hidden as long as the card does. Only offered once a model is set up: the focus view carries no setup
 * path. Offline, both are disabled, saying why, unless the model runs on this device.
 */
export function ExplainActions({ card, revealed, ai }: { card: CardView; revealed: boolean; ai: AiModelState }) {
  const t = useT()
  const chat = useChat()
  const online = useCanCallAi(ai)
  const offlineId = useId()
  const scopeOf = useCallback((el: Element) => el.closest(FACES), [])
  const { selected, launcher, clear } = useSelectedTerm(scopeOf)
  const { target, open, launch, close } = useExplainTarget()

  if (ai.status !== 'ready') return null

  const askTerm = () => {
    if (!selected || !chat) return
    // The term is read in the question alone until the answer shows.
    chat.ask(t('chat.termQuestion', { term: selected.term }), revealed ? `${card.front}\n\n${card.back}` : card.front)
    clear()
  }

  return (
    <div className={styles.explain}>
      <div ref={launcher} className={styles.actions}>
        <Button
          variant="plain"
          icon={<CircleHelp size={18} strokeWidth={1.75} aria-hidden />}
          disabled={!online}
          aria-describedby={online ? undefined : offlineId}
          onClick={() => launch('question')}
        >
          {t('ai.explainQuestion')}
        </Button>
        {revealed && (
          <Button
            variant="plain"
            icon={<Lightbulb size={18} strokeWidth={1.75} aria-hidden />}
            disabled={!online}
            aria-describedby={online ? undefined : offlineId}
            onClick={() => launch('answer')}
          >
            {t('review.why')}
          </Button>
        )}
        {selected && chat && (
          <Button
            variant="plain"
            icon={<MessageCircle size={18} strokeWidth={1.75} aria-hidden />}
            disabled={!online}
            aria-describedby={online ? undefined : offlineId}
            onMouseDown={keepSelection}
            onClick={askTerm}
          >
            {t('chat.askTerm', { term: selected.term })}
          </Button>
        )}
      </div>
      {!online && (
        <p id={offlineId} className={styles.note}>
          {t('ai.explainOffline')}
        </p>
      )}
      <ExplainSheetSlot
        ai={ai}
        target={target}
        open={open}
        onClose={close}
        courseId={card.courseId}
        card={{ front: card.front, back: card.back }}
        revealed={revealed}
      />
    </div>
  )
}
