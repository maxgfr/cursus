import { CircleHelp, Lightbulb, MessageCircle } from 'lucide-react'
import { useCallback, useId } from 'react'
import { useT } from '../../i18n/react.tsx'
import { useChat } from '../../ui/chat/context.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { keepSelection, useCanCallAi, useSelectedTerm } from '../../ui/ExplainLauncher.tsx'
import type { AiModelState } from '../Understand/shared/aiConfig.ts'
import styles from './ExplainActions.module.css'
import type { CardView } from './session.ts'

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

  if (ai.status !== 'ready' || !chat) return null

  const askTerm = () => {
    if (!selected) return
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
          onClick={() => chat.run('explainQuestion')}
        >
          {t('ai.explainQuestion')}
        </Button>
        {revealed && (
          <Button
            variant="plain"
            icon={<Lightbulb size={18} strokeWidth={1.75} aria-hidden />}
            disabled={!online}
            aria-describedby={online ? undefined : offlineId}
            onClick={() => chat.run('why')}
          >
            {t('review.why')}
          </Button>
        )}
        {selected && (
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
    </div>
  )
}
