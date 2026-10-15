import { BookOpen, CircleHelp } from 'lucide-react'
import { useCallback, useId } from 'react'
import { useT } from '../../i18n/react.tsx'
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

/** The faces of the card on screen: a term selected there can be explained. */
const FACES = '[data-testid="question"], [data-testid="answer"]'

/**
 * « Explain the question » and « Explain a concept » (typed, or the term selected in the card), before
 * and after the reveal. Before it, the sheet never shows the answer. Only offered once a model is set up:
 * the focus view carries no setup path. Offline, both are disabled, saying why, unless the model runs on
 * this device.
 */
export function ExplainActions({ card, revealed, ai }: { card: CardView; revealed: boolean; ai: AiModelState }) {
  const t = useT()
  const online = useCanCallAi(ai)
  const offlineId = useId()
  const scopeOf = useCallback((el: Element) => el.closest(FACES), [])
  const { selected, launcher, clear } = useSelectedTerm(scopeOf)
  const { target, open, launch, close } = useExplainTarget()

  if (ai.status !== 'ready') return null
  // What the concept is explained in: the question alone until the answer shows.
  const context = revealed ? `${card.front}\n\n${card.back}` : card.front

  const explainConcept = () => {
    launch({ kind: 'concept', term: selected?.term ?? '', context })
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
          onClick={() => launch({ kind: 'question' })}
        >
          {t('ai.explainQuestion')}
        </Button>
        <Button
          variant="plain"
          icon={<BookOpen size={18} strokeWidth={1.75} aria-hidden />}
          disabled={!online}
          aria-describedby={online ? undefined : offlineId}
          onMouseDown={keepSelection}
          onClick={explainConcept}
        >
          {selected ? t('ai.explainTerm', { term: selected.term }) : t('ai.explainConcept')}
        </Button>
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
